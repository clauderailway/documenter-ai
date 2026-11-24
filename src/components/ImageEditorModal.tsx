import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Eraser,
  Loader2,
  Paintbrush,
  Pipette,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { EnrichmentSettings, WebpImageAsset } from "../types/product.ts";
import { formatBytes } from "../utils/exportHelpers.ts";

type EditorTool = "crop" | "logo_box" | "smart_brush" | "paint_brush" | "eyedropper";
type CropAspect = "free" | "1:1" | "4:3";

interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ImageEditorModalProps {
  isOpen: boolean;
  images: WebpImageAsset[];
  initialIndex: number;
  productTitle: string;
  settings: EnrichmentSettings;
  onClose: () => void;
  onReplaceImage: (oldImageId: string, updated: WebpImageAsset) => void;
  onDeleteImage: (imageId: string) => void;
  onToggleSelect: (imageId: string) => void;
  onSetPrimary: (imageId: string) => void;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Multi-pass boundary-diffusion inpainting on an arbitrary boolean mask inside ImageData.
 * Works great for removing corner logos, watermarks, price badges, and text overlays
 * on studio backgrounds and gradients.
 */
function inpaintMaskedRegion(
  imgData: ImageData,
  mask: Uint8Array,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): ImageData {
  const { width, height, data } = imgData;
  const x0 = Math.max(1, minX);
  const y0 = Math.max(1, minY);
  const x1 = Math.min(width - 2, maxX);
  const y1 = Math.min(height - 2, maxY);

  // Initialize masked pixels to the average of nearest unmasked neighbors along scanlines
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = y * width + x;
      if (!mask[idx]) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let weightSum = 0;

      // Sample left, right, top, bottom nearest unmasked border pixels
      const dirs: [number, number][] = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const [dx, dy] of dirs) {
        let sx = x + dx;
        let sy = y + dy;
        let dist = 1;
        while (sx >= 0 && sx < width && sy >= 0 && sy < height && dist < 400) {
          const sIdx = sy * width + sx;
          if (!mask[sIdx]) {
            const w = 1 / (dist * dist + 0.5);
            const p = sIdx * 4;
            sumR += data[p] * w;
            sumG += data[p + 1] * w;
            sumB += data[p + 2] * w;
            weightSum += w;
            break;
          }
          sx += dx;
          sy += dy;
          dist += 1;
        }
      }

      if (weightSum > 0) {
        const p = idx * 4;
        data[p] = Math.round(sumR / weightSum);
        data[p + 1] = Math.round(sumG / weightSum);
        data[p + 2] = Math.round(sumB / weightSum);
        data[p + 3] = 255;
      }
    }
  }

  // Smooth inward with iterative 4-neighbor harmonic relaxation
  const regionW = x1 - x0 + 1;
  const regionH = y1 - y0 + 1;
  const passes = Math.min(90, Math.max(24, Math.round(Math.max(regionW, regionH) * 0.65)));

  for (let pass = 0; pass < passes; pass++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = y * width + x;
        if (!mask[idx]) continue;
        const p = idx * 4;
        const pL = (idx - 1) * 4;
        const pR = (idx + 1) * 4;
        const pU = (idx - width) * 4;
        const pD = (idx + width) * 4;

        data[p] = (data[pL] + data[pR] + data[pU] + data[pD]) >> 2;
        data[p + 1] = (data[pL + 1] + data[pR + 1] + data[pU + 1] + data[pD + 1]) >> 2;
        data[p + 2] = (data[pL + 2] + data[pR + 2] + data[pU + 2] + data[pD + 2]) >> 2;
      }
    }
  }

  return imgData;
}

export const ImageEditorModal: React.FC<ImageEditorModalProps> = ({
  isOpen,
  images,
  initialIndex,
  productTitle,
  settings,
  onClose,
  onReplaceImage,
  onDeleteImage,
  onToggleSelect,
  onSetPrimary,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [tool, setTool] = useState<EditorTool>("crop");
  const [cropAspect, setCropAspect] = useState<CropAspect>("free");
  const [cropRect, setCropRect] = useState<NormRect>({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 });
  const [logoBox, setLogoBox] = useState<NormRect | null>(null);
  const [brushSize, setBrushSize] = useState(26);
  const [paintColor, setPaintColor] = useState("#ffffff");
  const [saveFitMode, setSaveFitMode] = useState<"inside" | "contain_white">("inside");

  const [isLoadingImg, setIsLoadingImg] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [canvasDims, setCanvasDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [undoCount, setUndoCount] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const originalDataRef = useRef<ImageData | null>(null);

  // Brush stroke mask for smart_brush tool
  const brushMaskRef = useRef<Uint8Array | null>(null);
  const brushBoundsRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(
    null
  );
  const dragModeRef = useRef<
    | null
    | { kind: "draw_crop"; startX: number; startY: number }
    | { kind: "move_crop"; startX: number; startY: number; orig: NormRect }
    | { kind: "resize_crop"; corner: "nw" | "ne" | "sw" | "se"; orig: NormRect }
    | { kind: "draw_logo"; startX: number; startY: number }
    | { kind: "brush"; lastPx: number; lastPy: number }
  >(null);

  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(clamp(initialIndex, 0, Math.max(0, images.length - 1)));
      setStatusMessage(null);
    }
  }, [isOpen, initialIndex, images.length]);

  useEffect(() => {
    if (currentIndex >= images.length && images.length > 0) {
      setCurrentIndex(images.length - 1);
    }
  }, [images.length, currentIndex]);

  const currentImage = images[currentIndex] ?? null;

  // Load current image onto canvas via same-origin WebP or proxy fallback
  useEffect(() => {
    if (!isOpen || !currentImage) return;
    let cancelled = false;
    setIsLoadingImg(true);
    setHasUnsavedEdits(false);
    setStatusMessage(null);
    setLogoBox(null);
    setCropRect({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 });
    undoStackRef.current = [];
    setUndoCount(0);

    const loadSrc = (src: string, allowFallback: boolean) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = img.naturalWidth || 800;
        canvas.height = img.naturalHeight || 800;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
        originalDataRef.current = snap;
        setCanvasDims({ w: canvas.width, h: canvas.height });
        setIsLoadingImg(false);
      };
      img.onerror = () => {
        if (cancelled) return;
        if (allowFallback && currentImage.sourceUrl && /^https?:\/\//i.test(currentImage.sourceUrl)) {
          loadSrc(`/api/proxy-image?url=${encodeURIComponent(currentImage.sourceUrl)}`, false);
        } else {
          setIsLoadingImg(false);
          setStatusMessage("بارگذاری این تصویر برای ویرایش ناموفق بود.");
        }
      };
      img.src = src;
    };

    loadSrc(currentImage.url, true);

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentImage?.id, currentImage?.url]);

  const pushUndoSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    undoStackRef.current = [...undoStackRef.current.slice(-14), snap];
    setUndoCount(undoStackRef.current.length);
  }, []);

  const handleUndo = () => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    undoStackRef.current = stack.slice(0, -1);
    setUndoCount(undoStackRef.current.length);

    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = prev.width;
    canvas.height = prev.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.putImageData(prev, 0, 0);
    setCanvasDims({ w: prev.width, h: prev.height });
    setHasUnsavedEdits(undoStackRef.current.length > 0);
    setStatusMessage("یک مرحله به عقب بازگشت.");
  };

  const handleReset = () => {
    const orig = originalDataRef.current;
    const canvas = canvasRef.current;
    if (!orig || !canvas) return;
    canvas.width = orig.width;
    canvas.height = orig.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.putImageData(orig, 0, 0);
    undoStackRef.current = [];
    setUndoCount(0);
    setCanvasDims({ w: orig.width, h: orig.height });
    setCropRect({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 });
    setLogoBox(null);
    setHasUnsavedEdits(false);
    setStatusMessage("تصویر به حالت اولیه برگشت.");
  };

  const applyAspectToRect = useCallback(
    (rect: NormRect, aspect: CropAspect): NormRect => {
      if (aspect === "free" || !canvasDims.w || !canvasDims.h) return rect;
      const targetRatio = aspect === "1:1" ? 1 : 4 / 3;
      const pxW = rect.w * canvasDims.w;
      const pxH = rect.h * canvasDims.h;
      let newPxW = pxW;
      let newPxH = pxW / targetRatio;
      if (newPxH > canvasDims.h - rect.y * canvasDims.h) {
        newPxH = pxH;
        newPxW = pxH * targetRatio;
      }
      const w = clamp(newPxW / canvasDims.w, 0.05, 1 - rect.x);
      const h = clamp(newPxH / canvasDims.h, 0.05, 1 - rect.y);
      return { x: rect.x, y: rect.y, w, h };
    },
    [canvasDims]
  );

  const handleApplyCrop = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const sx = Math.round(cropRect.x * canvas.width);
    const sy = Math.round(cropRect.y * canvas.height);
    const sw = Math.max(40, Math.round(cropRect.w * canvas.width));
    const sh = Math.max(40, Math.round(cropRect.h * canvas.height));

    pushUndoSnapshot();
    const cropped = ctx.getImageData(sx, sy, Math.min(sw, canvas.width - sx), Math.min(sh, canvas.height - sy));
    canvas.width = cropped.width;
    canvas.height = cropped.height;
    ctx.putImageData(cropped, 0, 0);
    setCanvasDims({ w: cropped.width, h: cropped.height });
    setCropRect({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
    setHasUnsavedEdits(true);
    setStatusMessage(`برش انجام شد (${cropped.width}×${cropped.height}).`);
  };

  const applyLogoRemovalOnRect = (box: NormRect, solidWhite = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const minX = Math.max(1, Math.floor(box.x * canvas.width));
    const minY = Math.max(1, Math.floor(box.y * canvas.height));
    const maxX = Math.min(canvas.width - 2, Math.ceil((box.x + box.w) * canvas.width));
    const maxY = Math.min(canvas.height - 2, Math.ceil((box.y + box.h) * canvas.height));
    if (maxX <= minX || maxY <= minY) return;

    pushUndoSnapshot();

    if (solidWhite) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(minX, minY, maxX - minX + 1, maxY - minY + 1);
    } else {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const mask = new Uint8Array(canvas.width * canvas.height);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          mask[y * canvas.width + x] = 1;
        }
      }
      inpaintMaskedRegion(imgData, mask, minX, minY, maxX, maxY);
      ctx.putImageData(imgData, 0, 0);
    }

    setLogoBox(null);
    setHasUnsavedEdits(true);
    setStatusMessage(
      solidWhite ? "ناحیه انتخاب‌شده با سفید جایگزین شد." : "لوگو / واترمارک انتخاب‌شده حذف و با اطراف ترکیب شد."
    );
  };

  const getNormCoords = (clientX: number, clientY: number): { nx: number; ny: number } => {
    const el = overlayRef.current;
    if (!el) return { nx: 0, ny: 0 };
    const rect = el.getBoundingClientRect();
    return {
      nx: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      ny: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    };
  };

  const paintCircleInMask = (cx: number, cy: number, radiusPx: number) => {
    const canvas = canvasRef.current;
    const mask = brushMaskRef.current;
    if (!canvas || !mask) return;
    const r = Math.max(2, radiusPx);
    const r2 = r * r;
    const xStart = Math.max(1, Math.floor(cx - r));
    const xEnd = Math.min(canvas.width - 2, Math.ceil(cx + r));
    const yStart = Math.max(1, Math.floor(cy - r));
    const yEnd = Math.min(canvas.height - 2, Math.ceil(cy + r));

    for (let y = yStart; y <= yEnd; y++) {
      for (let x = xStart; x <= xEnd; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          mask[y * canvas.width + x] = 1;
        }
      }
    }

    if (!brushBoundsRef.current) {
      brushBoundsRef.current = { minX: xStart, minY: yStart, maxX: xEnd, maxY: yEnd };
    } else {
      brushBoundsRef.current.minX = Math.min(brushBoundsRef.current.minX, xStart);
      brushBoundsRef.current.minY = Math.min(brushBoundsRef.current.minY, yStart);
      brushBoundsRef.current.maxX = Math.max(brushBoundsRef.current.maxX, xEnd);
      brushBoundsRef.current.maxY = Math.max(brushBoundsRef.current.maxY, yEnd);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isLoadingImg) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { nx, ny } = getNormCoords(e.clientX, e.clientY);

    if (tool === "eyedropper") {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const px = clamp(Math.floor(nx * canvas.width), 0, canvas.width - 1);
      const py = clamp(Math.floor(ny * canvas.height), 0, canvas.height - 1);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]]
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("")}`;
      setPaintColor(hex);
      setTool("paint_brush");
      setStatusMessage("رنگ پس‌زمینه نمونه برداشته شد. اکنون روی لوگو بکشید.");
      return;
    }

    if (tool === "crop") {
      const hitTol = 0.035;
      const corners: { key: "nw" | "ne" | "sw" | "se"; x: number; y: number }[] = [
        { key: "nw", x: cropRect.x, y: cropRect.y },
        { key: "ne", x: cropRect.x + cropRect.w, y: cropRect.y },
        { key: "sw", x: cropRect.x, y: cropRect.y + cropRect.h },
        { key: "se", x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
      ];
      const hitCorner = corners.find(
        (c) => Math.abs(nx - c.x) < hitTol && Math.abs(ny - c.y) < hitTol
      );
      if (hitCorner) {
        dragModeRef.current = { kind: "resize_crop", corner: hitCorner.key, orig: cropRect };
        return;
      }
      if (
        nx >= cropRect.x &&
        nx <= cropRect.x + cropRect.w &&
        ny >= cropRect.y &&
        ny <= cropRect.y + cropRect.h
      ) {
        dragModeRef.current = { kind: "move_crop", startX: nx, startY: ny, orig: cropRect };
        return;
      }
      dragModeRef.current = { kind: "draw_crop", startX: nx, startY: ny };
      setCropRect({ x: nx, y: ny, w: 0.02, h: 0.02 });
      return;
    }

    if (tool === "logo_box") {
      dragModeRef.current = { kind: "draw_logo", startX: nx, startY: ny };
      setLogoBox({ x: nx, y: ny, w: 0.01, h: 0.01 });
      return;
    }

    if (tool === "smart_brush" || tool === "paint_brush") {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      pushUndoSnapshot();
      const px = nx * canvas.width;
      const py = ny * canvas.height;
      const scaleFactor = canvas.width / Math.max(1, overlayRef.current?.clientWidth || canvas.width);
      const radiusPx = Math.max(3, (brushSize * scaleFactor) / 2);

      if (tool === "smart_brush") {
        brushMaskRef.current = new Uint8Array(canvas.width * canvas.height);
        brushBoundsRef.current = null;
        paintCircleInMask(px, py, radiusPx);
        // Visual translucent preview highlight on canvas until pointerUp runs inpaint
        ctx.save();
        ctx.fillStyle = "rgba(37, 99, 235, 0.35)";
        ctx.beginPath();
        ctx.arc(px, py, radiusPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = paintColor;
        ctx.beginPath();
        ctx.arc(px, py, radiusPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      dragModeRef.current = { kind: "brush", lastPx: px, lastPy: py };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const mode = dragModeRef.current;
    const canvas = canvasRef.current;
    if (!mode || !canvas) return;
    const { nx, ny } = getNormCoords(e.clientX, e.clientY);

    if (mode.kind === "draw_crop") {
      const x = Math.min(mode.startX, nx);
      const y = Math.min(mode.startY, ny);
      const w = Math.max(0.04, Math.abs(nx - mode.startX));
      const h = Math.max(0.04, Math.abs(ny - mode.startY));
      setCropRect(applyAspectToRect({ x, y, w, h }, cropAspect));
      return;
    }

    if (mode.kind === "move_crop") {
      const dx = nx - mode.startX;
      const dy = ny - mode.startY;
      setCropRect({
        ...mode.orig,
        x: clamp(mode.orig.x + dx, 0, 1 - mode.orig.w),
        y: clamp(mode.orig.y + dy, 0, 1 - mode.orig.h),
      });
      return;
    }

    if (mode.kind === "resize_crop") {
      const o = mode.orig;
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      if (mode.corner.includes("w")) left = Math.min(nx, right - 0.05);
      if (mode.corner.includes("e")) right = Math.max(nx, left + 0.05);
      if (mode.corner.includes("n")) top = Math.min(ny, bottom - 0.05);
      if (mode.corner.includes("s")) bottom = Math.max(ny, top + 0.05);
      setCropRect(
        applyAspectToRect(
          { x: left, y: top, w: right - left, h: bottom - top },
          cropAspect
        )
      );
      return;
    }

    if (mode.kind === "draw_logo") {
      const x = Math.min(mode.startX, nx);
      const y = Math.min(mode.startY, ny);
      const w = Math.max(0.01, Math.abs(nx - mode.startX));
      const h = Math.max(0.01, Math.abs(ny - mode.startY));
      setLogoBox({ x, y, w, h });
      return;
    }

    if (mode.kind === "brush") {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const px = nx * canvas.width;
      const py = ny * canvas.height;
      const scaleFactor = canvas.width / Math.max(1, overlayRef.current?.clientWidth || canvas.width);
      const radiusPx = Math.max(3, (brushSize * scaleFactor) / 2);

      if (tool === "smart_brush") {
        // Interpolate circles between lastPx/y and px/y
        const dist = Math.hypot(px - mode.lastPx, py - mode.lastPy);
        const steps = Math.max(1, Math.ceil(dist / Math.max(2, radiusPx * 0.45)));
        for (let s = 1; s <= steps; s++) {
          const ix = mode.lastPx + ((px - mode.lastPx) * s) / steps;
          const iy = mode.lastPy + ((py - mode.lastPy) * s) / steps;
          paintCircleInMask(ix, iy, radiusPx);
          ctx.save();
          ctx.fillStyle = "rgba(37, 99, 235, 0.25)";
          ctx.beginPath();
          ctx.arc(ix, iy, radiusPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.strokeStyle = paintColor;
        ctx.lineWidth = radiusPx * 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(mode.lastPx, mode.lastPy);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.restore();
      }
      mode.lastPx = px;
      mode.lastPy = py;
    }
  };

  const handlePointerUp = () => {
    const mode = dragModeRef.current;
    dragModeRef.current = null;
    if (!mode) return;

    if (mode.kind === "draw_logo" && logoBox && logoBox.w > 0.015 && logoBox.h > 0.015) {
      applyLogoRemovalOnRect(logoBox, false);
      return;
    }

    if (mode.kind === "brush") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      if (tool === "smart_brush" && brushMaskRef.current && brushBoundsRef.current) {
        // Restore clean snapshot before applying inpainting (so translucent blue preview isn't baked in)
        const cleanSnap = undoStackRef.current[undoStackRef.current.length - 1];
        if (cleanSnap) {
          ctx.putImageData(cleanSnap, 0, 0);
        }
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const { minX, minY, maxX, maxY } = brushBoundsRef.current;
        inpaintMaskedRegion(imgData, brushMaskRef.current, minX, minY, maxX, maxY);
        ctx.putImageData(imgData, 0, 0);
        brushMaskRef.current = null;
        brushBoundsRef.current = null;
        setHasUnsavedEdits(true);
        setStatusMessage("بخش انتخاب‌شده با قلم‌مو ترمیم و پاک شد.");
      } else if (tool === "paint_brush") {
        setHasUnsavedEdits(true);
      }
    }
  };

  const handleSaveEditedWebp = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !currentImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const res = await fetch("/api/images/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataUrl,
          sourceUrl: currentImage.sourceUrl,
          sourceDomain: currentImage.sourceDomain,
          isPrimary: currentImage.isPrimary,
          selected: currentImage.selected,
          fitMode: saveFitMode,
          settings,
        }),
      });
      const data = (await res.json()) as { image?: WebpImageAsset; error?: string };
      if (!res.ok || !data.image) {
        throw new Error(data.error || "خطا در ذخیره تصویر WebP");
      }
      onReplaceImage(currentImage.id, data.image);
      setHasUnsavedEdits(false);
      setStatusMessage("تصویر ویرایش‌شده با فرمت WebP ذخیره شد.");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "خطا در ذخیره تصویر");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !currentImage) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white w-full max-w-5xl rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[94vh]">
        {/* Top Modal Header */}
        <div className="px-4 sm:px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-3 bg-white">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-bold text-slate-900 truncate">
              ویرایش، برش و حذف لوگو — {productTitle || "تصویر محصول"}
            </h2>
            <p className="text-[11px] text-slate-500 font-mono tabular-nums" dir="ltr">
              {currentIndex + 1} / {images.length} · {canvasDims.w}×{canvasDims.h} ·{" "}
              {formatBytes(currentImage.sizeBytes)}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onToggleSelect(currentImage.id)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                currentImage.selected
                  ? "border-blue-600 bg-blue-50 text-blue-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Check className="w-3.5 h-3.5" />
              {currentImage.selected ? "انتخاب‌شده" : "افزودن به خروجی"}
            </button>

            <button
              type="button"
              onClick={() => onSetPrimary(currentImage.id)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                currentImage.isPrimary
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${currentImage.isPrimary ? "fill-amber-500" : ""}`} />
              شاخص
            </button>

            <button
              type="button"
              onClick={() => onDeleteImage(currentImage.id)}
              className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50/70 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              حذف عکس
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
              title="بستن"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editing Toolbar */}
        <div className="px-4 sm:px-5 py-2.5 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTool("crop")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                tool === "crop"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <Crop className="w-3.5 h-3.5" />
              برش (Cut)
            </button>

            <button
              type="button"
              onClick={() => setTool("logo_box")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                tool === "logo_box"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              کادر حذف لوگو / واترمارک
            </button>

            <button
              type="button"
              onClick={() => setTool("smart_brush")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                tool === "smart_brush"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <Eraser className="w-3.5 h-3.5" />
              پاک‌کن قلمی هوشمند
            </button>

            <button
              type="button"
              onClick={() => setTool("paint_brush")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                tool === "paint_brush"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <Paintbrush className="w-3.5 h-3.5" />
              قلم‌موی رنگ
            </button>

            <button
              type="button"
              onClick={() => setTool("eyedropper")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                tool === "eyedropper"
                  ? "bg-blue-700 text-white"
                  : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
              }`}
              title="نمونه‌گیری رنگ از تصویر"
            >
              <Pipette className="w-3.5 h-3.5" />
              قطره‌چکان
            </button>
          </div>

          {/* Tool Sub-Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {tool === "crop" && (
              <>
                <div className="flex items-center bg-white border border-slate-200 rounded-lg p-0.5 text-[11px]">
                  {(
                    [
                      { id: "free", label: "آزاد" },
                      { id: "1:1", label: "۱:۱ مربع" },
                      { id: "4:3", label: "۴:۳" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setCropAspect(opt.id);
                        setCropRect((prev) => applyAspectToRect(prev, opt.id));
                      }}
                      className={`px-2 py-1 rounded-md cursor-pointer ${
                        cropAspect === opt.id
                          ? "bg-slate-900 text-white font-medium"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleApplyCrop}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 cursor-pointer whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5" />
                  اعمال برش
                </button>
              </>
            )}

            {(tool === "smart_brush" || tool === "paint_brush") && (
              <div className="flex items-center gap-2 text-xs text-slate-700">
                <span>اندازه قلم:</span>
                <input
                  type="range"
                  min={8}
                  max={72}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-24 accent-blue-700"
                />
                <span className="font-mono w-7 text-center">{brushSize}</span>
                {tool === "paint_brush" && (
                  <>
                    <input
                      type="color"
                      value={paintColor}
                      onChange={(e) => setPaintColor(e.target.value)}
                      className="w-6 h-6 rounded border border-slate-300 cursor-pointer"
                      title="انتخاب رنگ قلم"
                    />
                    <button
                      type="button"
                      onClick={() => setPaintColor("#ffffff")}
                      className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] hover:bg-slate-100 cursor-pointer"
                    >
                      سفید
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-1.5 border-r border-slate-200 pr-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoCount === 0}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
                عقب
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={undoCount === 0}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                اصلی
              </button>
            </div>
          </div>
        </div>

        {/* Canvas Workspace */}
        <div className="flex-1 bg-slate-100 overflow-auto flex items-center justify-center p-4 relative min-h-[320px]">
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setCurrentIndex((i) => (i - 1 + images.length) % images.length)}
                className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-white/95 border border-slate-200 shadow flex items-center justify-center text-slate-700 hover:bg-white cursor-pointer"
                title="تصویر قبلی"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => setCurrentIndex((i) => (i + 1) % images.length)}
                className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-white/95 border border-slate-200 shadow flex items-center justify-center text-slate-700 hover:bg-white cursor-pointer"
                title="تصویر بعدی"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            </>
          )}

          {isLoadingImg && (
            <div className="absolute inset-0 z-10 bg-slate-100/80 flex items-center justify-center gap-2 text-xs text-slate-600">
              <Loader2 className="w-5 h-5 animate-spin text-blue-700" />
              در حال آماده‌سازی تصویر...
            </div>
          )}

          <div
            ref={overlayRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`relative inline-block shadow-md bg-white border border-slate-200 select-none touch-none max-w-full max-h-[54vh] ${
              tool === "eyedropper" || tool === "logo_box"
                ? "cursor-crosshair"
                : tool === "smart_brush" || tool === "paint_brush"
                  ? "cursor-cell"
                  : "cursor-default"
            }`}
          >
            <canvas
              ref={canvasRef}
              className="block max-w-full max-h-[54vh] w-auto h-auto"
            />

            {/* Crop Selection Overlay (SVG mask + crisp corners) */}
            {tool === "crop" && !isLoadingImg && (
              <svg
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none"
              >
                <defs>
                  <mask id="kalasaz-crop-mask">
                    <rect x="0" y="0" width="1000" height="1000" fill="white" />
                    <rect
                      x={cropRect.x * 1000}
                      y={cropRect.y * 1000}
                      width={cropRect.w * 1000}
                      height={cropRect.h * 1000}
                      fill="black"
                    />
                  </mask>
                </defs>
                <rect
                  x="0"
                  y="0"
                  width="1000"
                  height="1000"
                  fill="rgba(15, 23, 42, 0.45)"
                  mask="url(#kalasaz-crop-mask)"
                />
                <rect
                  x={cropRect.x * 1000}
                  y={cropRect.y * 1000}
                  width={cropRect.w * 1000}
                  height={cropRect.h * 1000}
                  fill="rgba(37, 99, 235, 0.08)"
                  stroke="#2563eb"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={cropRect.x * 1000} cy={cropRect.y * 1000} r="10" fill="#ffffff" stroke="#1d4ed8" strokeWidth="3" />
                <circle cx={(cropRect.x + cropRect.w) * 1000} cy={cropRect.y * 1000} r="10" fill="#ffffff" stroke="#1d4ed8" strokeWidth="3" />
                <circle cx={cropRect.x * 1000} cy={(cropRect.y + cropRect.h) * 1000} r="10" fill="#ffffff" stroke="#1d4ed8" strokeWidth="3" />
                <circle cx={(cropRect.x + cropRect.w) * 1000} cy={(cropRect.y + cropRect.h) * 1000} r="10" fill="#ffffff" stroke="#1d4ed8" strokeWidth="3" />
              </svg>
            )}

            {/* Logo Removal Drag Box Overlay */}
            {tool === "logo_box" && logoBox && (
              <svg
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none"
              >
                <rect
                  x={logoBox.x * 1000}
                  y={logoBox.y * 1000}
                  width={logoBox.w * 1000}
                  height={logoBox.h * 1000}
                  fill="rgba(245, 158, 11, 0.22)"
                  stroke="#f59e0b"
                  strokeWidth="3"
                  strokeDasharray="10 6"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        </div>

        {/* Tip + Thumbnail Strip + Save Footer */}
        <div className="px-4 sm:px-5 py-3 border-t border-slate-200 bg-white space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-600">
              {statusMessage ||
                (tool === "crop"
                  ? "کادر آبی را روی بخش دلخواه جابه‌جا یا تنظیم کنید و روی «اعمال برش» بزنید."
                  : tool === "logo_box"
                    ? "با ماوس یا انگشت کادری دور لوگو یا واترمارک بکشید تا بلافاصله محو و با پس‌زمینه ترکیب شود."
                    : tool === "smart_brush"
                      ? "روی لوگو یا متن اضافی قلم بکشید؛ به محض رها کردن، با رنگ اطراف ترمیم می‌شود."
                      : tool === "paint_brush"
                        ? "با رنگ انتخابی روی لکه‌ها بکشید (برای پس‌زمینه سفید، رنگ سفید فعال است)."
                        : "روی نقطه‌ای از پس‌زمینه تصویر کلیک کنید تا رنگ آن برداشته شود.")}
            </span>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveFitMode === "contain_white"}
                  onChange={(e) =>
                    setSaveFitMode(e.target.checked ? "contain_white" : "inside")
                  }
                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                />
                مربع کادر سفید ۱:۱ هنگام ذخیره
              </label>

              <button
                type="button"
                onClick={handleSaveEditedWebp}
                disabled={isSaving || isLoadingImg}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {hasUnsavedEdits ? "ذخیره تغییرات WebP" : "ذخیره با فرمت WebP"}
              </button>
            </div>
          </div>

          {/* Thumbnail Strip */}
          {images.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto pt-1">
              {images.map((img, idx) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setCurrentIndex(idx)}
                  className={`relative w-12 h-12 rounded-md border overflow-hidden shrink-0 bg-slate-50 cursor-pointer ${
                    idx === currentIndex
                      ? "border-blue-700 ring-2 ring-blue-600/25"
                      : "border-slate-200 opacity-75 hover:opacity-100"
                  }`}
                >
                  <img
                    src={img.url}
                    alt=""
                    className="w-full h-full object-contain p-0.5"
                  />
                  {!img.selected && (
                    <span className="absolute inset-0 bg-white/60" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
