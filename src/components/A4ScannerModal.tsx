import React, { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  FileScan,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { DomainProfile, EnrichmentSettings } from "../types/product.ts";

interface ScannedRow {
  id: string;
  text: string;
  checked: boolean;
}

interface A4ScannerModalProps {
  isOpen: boolean;
  domainProfile: DomainProfile;
  settings: EnrichmentSettings;
  onClose: () => void;
  onConfirmItems: (names: string[], autoStart: boolean) => void;
}

export const A4ScannerModal: React.FC<A4ScannerModalProps> = ({
  isOpen,
  domainProfile,
  settings,
  onClose,
  onConfirmItems,
}) => {
  const [mode, setMode] = useState<"upload" | "camera">("upload");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [rows, setRows] = useState<ScannedRow[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return;
    }
    if (mode === "camera") {
      let cancelled = false;
      setCameraError(null);
      navigator.mediaDevices
        ?.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
        .then((stream) => {
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          setIsCameraActive(true);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCameraError(
              "دسترسی به دوربین در دسترس نیست یا رد شده است. می‌توانید عکس یا فایل اسکن برگه A4 را آپلود کنید."
            );
          }
        });

      return () => {
        cancelled = true;
        stopCamera();
      };
    } else {
      stopCamera();
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const compressImageDataUrl = async (rawDataUrl: string, maxDim = 2000, quality = 0.85): Promise<string> => {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode_failed"));
        el.src = rawDataUrl;
      });
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) return rawDataUrl;

      const scale = Math.min(1, maxDim / Math.max(width, height));
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return rawDataUrl;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, 0, 0, targetW, targetH);
      return canvas.toDataURL("image/jpeg", quality);
    } catch {
      return rawDataUrl;
    }
  };

  const processDataUrlScan = async (dataUrl: string, label: string, isImage: boolean) => {
    setIsScanning(true);
    setScanError(null);
    setScanNote(null);

    const payloadDataUrl = isImage ? await compressImageDataUrl(dataUrl) : dataUrl;

    if (isImage) {
      setPreviewUrl(payloadDataUrl);
    } else {
      setPreviewUrl(null);
    }
    setPreviewLabel(label);

    try {
      const res = await fetch("/api/scan/extract-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: payloadDataUrl, domainProfile, settings }),
      });

      const rawText = await res.text();
      let data: { items?: string[]; note?: string; error?: string } | null = null;
      try {
        data = JSON.parse(rawText) as { items?: string[]; note?: string; error?: string };
      } catch {
        data = null;
      }

      if (!data) {
        if (res.status === 413) {
          throw new Error("حجم فایل ارسالی زیاد است. لطفاً تصویر کم‌حجم‌تر یا با کیفیت متوسط ارسال کنید.");
        }
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new Error("پاسخ‌دهی سرور به دلیل شلوغی یا محدودیت زمان قطع شد. لطفاً چند لحظه بعد دوباره امتحان کنید.");
        }
        throw new Error(
          `پاسخ غیرمنتظره از سرور دریافت شد (کد ${res.status}). لطفاً اتصال اینترنت یا کلید API را بررسی کرده و دوباره تلاش کنید.`
        );
      }

      if (!res.ok) {
        throw new Error(data.error || "خطا در خواندن متن برگه");
      }

      const extracted = (data.items ?? []).map((text, idx) => ({
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        checked: true,
      }));

      if (extracted.length === 0) {
        setScanError("نام کالایی روی این برگه تشخیص داده نشد. لطفاً تصویر واضح‌تری انتخاب کنید.");
      } else {
        setRows((prev) => [...prev, ...extracted]);
      }

      if (data.note) {
        setScanNote(data.note);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "خطا در اسکن برگه");
    } finally {
      setIsScanning(false);
    }
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      if (!isImage && file.size > 18 * 1024 * 1024) {
        setScanError("حجم فایل PDF نباید بیشتر از ۱۸ مگابایت باشد.");
        continue;
      }
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      await processDataUrlScan(dataUrl, file.name, isImage);
    }
  };

  const handleCaptureCamera = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const maxDim = 2000;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    stopCamera();
    setMode("upload");
    void processDataUrlScan(dataUrl, "تصویر دوربین", true);
  };

  const checkedNames = rows
    .filter((r) => r.checked && r.text.trim())
    .map((r) => r.text.trim());

  const handleReset = () => {
    setRows([]);
    setPreviewUrl(null);
    setPreviewLabel("");
    setScanError(null);
    setScanNote(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="a4-scanner-title"
    >
      <div className="w-full max-w-4xl max-h-[90vh] bg-white rounded-xl border border-slate-200 shadow-xl flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <FileScan className="w-5 h-5 text-blue-700" />
            <div>
              <h2 id="a4-scanner-title" className="text-base font-bold text-slate-900">
                اسکن برگه A4 لیست محصولات
              </h2>
              <p className="text-xs text-slate-500">
                اسکن چاپی، جدولی، فاکتور یا دست‌نویس را آپلود یا عکسبرداری کنید تا نام کالاها خودکار وارد صف شوند
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
            title="بستن"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Source Mode Switch */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setMode("upload")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === "upload"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                آپلود اسکن برگه یا PDF
              </button>
              <button
                type="button"
                onClick={() => setMode("camera")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === "camera"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Camera className="w-3.5 h-3.5" />
                اسکن مستقیم با دوربین
              </button>
            </div>

            {rows.length > 0 && (
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                پاک‌کردن و اسکن جدید
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Left/Right Col 1: Scanner / Preview */}
            <div className="space-y-3">
              {mode === "camera" ? (
                <div className="rounded-xl border border-slate-200 bg-slate-950 overflow-hidden relative aspect-[3/4] max-h-[380px] flex items-center justify-center">
                  {cameraError ? (
                    <div className="p-6 text-center space-y-3">
                      <p className="text-xs text-slate-300 leading-relaxed">{cameraError}</p>
                      <button
                        type="button"
                        onClick={() => setMode("upload")}
                        className="rounded-lg bg-white px-3.5 py-2 text-xs font-medium text-slate-900 cursor-pointer"
                      >
                        آپلود فایل عکس یا اسکن
                      </button>
                    </div>
                  ) : (
                    <>
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      {/* Framing Guide */}
                      <div className="pointer-events-none absolute inset-4 border border-dashed border-white/50 rounded-lg" />
                      {isCameraActive && (
                        <button
                          type="button"
                          onClick={handleCaptureCamera}
                          className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-xs font-medium text-white hover:bg-blue-800 shadow-lg cursor-pointer whitespace-nowrap"
                        >
                          <Camera className="w-4 h-4" />
                          ثبت عکس و استخراج لیست
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleFilesSelected(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  className="rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100/70 hover:border-blue-500 transition-colors p-5 flex flex-col items-center justify-center text-center gap-2.5 min-h-[220px] cursor-pointer"
                >
                  {isScanning ? (
                    <>
                      <Loader2 className="w-7 h-7 text-blue-700 animate-spin" />
                      <div className="text-sm font-medium text-slate-900">
                        در حال خواندن متن و استخراج نام کالاها از برگه...
                      </div>
                      <div className="text-xs text-slate-500">{previewLabel}</div>
                    </>
                  ) : previewUrl ? (
                    <div className="space-y-2 w-full">
                      <img
                        src={previewUrl}
                        alt={previewLabel}
                        className="max-h-[260px] mx-auto rounded-lg border border-slate-200 object-contain bg-white"
                      />
                      <div className="text-xs text-blue-700 font-medium">
                        برای افزودن برگه دیگر کلیک کنید یا فایل را اینجا بکشید
                      </div>
                    </div>
                  ) : (
                    <>
                      <FileScan className="w-8 h-8 text-slate-400" />
                      <div className="text-sm font-semibold text-slate-800">
                        عکس برگه A4 یا فایل PDF را اینجا بکشید یا کلیک کنید
                      </div>
                      <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                        پشتیبانی از برگه‌های چاپی، جدول اکسل پرینت‌شده، فاکتور خرید و لیست دست‌نویس فارسی و انگلیسی
                      </p>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    onChange={(e) => {
                      void handleFilesSelected(e.target.files);
                      e.target.value = "";
                    }}
                    className="hidden"
                  />
                </div>
              )}

              {scanError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
                  {scanError}
                </div>
              )}

              {scanNote && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-600">
                  {scanNote}
                </div>
              )}
            </div>

            {/* Col 2: Extracted Checklist */}
            <div className="flex flex-col border border-slate-200 rounded-xl overflow-hidden bg-white min-h-[260px] max-h-[380px]">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 tabular-nums">
                  کالاهای استخراج‌شده ({checkedNames.length} از {rows.length})
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setRows((prev) => [
                      ...prev,
                      {
                        id: `${Date.now()}-manual`,
                        text: "",
                        checked: true,
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  افزودن سطر
                </button>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {rows.length === 0 ? (
                  <div className="h-full flex items-center justify-center p-6 text-center text-xs text-slate-400">
                    پس از اسکن برگه A4، لیست نام محصولات اینجا نمایش داده می‌شود تا قبل از جستجو ویرایش یا تایید کنید.
                  </div>
                ) : (
                  rows.map((row) => (
                    <div
                      key={row.id}
                      className="px-3 py-2 flex items-center gap-2 hover:bg-slate-50/70"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id ? { ...r, checked: !r.checked } : r
                            )
                          )
                        }
                        className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 cursor-pointer ${
                          row.checked
                            ? "bg-blue-700 border-blue-700 text-white"
                            : "border-slate-300 bg-white"
                        }`}
                      >
                        {row.checked && <Check className="w-3 h-3" />}
                      </button>

                      <input
                        type="text"
                        value={row.text}
                        placeholder="نام کالا..."
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id ? { ...r, text: e.target.value } : r
                            )
                          )
                        }
                        className="flex-1 rounded border border-transparent focus:border-blue-600 bg-transparent focus:bg-white px-2 py-1 text-xs text-slate-900 focus:outline-none"
                      />

                      <button
                        type="button"
                        onClick={() =>
                          setRows((prev) => prev.filter((r) => r.id !== row.id))
                        }
                        className="p-1 text-slate-400 hover:text-red-700 cursor-pointer"
                        title="حذف سطر"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            پس از تایید، کالاها به صورت خودکار و یکی‌یکی در صف جستجو و تبدیل WebP می‌شوند.
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (checkedNames.length === 0) return;
                onConfirmItems(checkedNames, false);
                handleReset();
                onClose();
              }}
              disabled={checkedNames.length === 0 || isScanning}
              className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              فقط افزودن به صف ({checkedNames.length})
            </button>

            <button
              type="button"
              onClick={() => {
                if (checkedNames.length === 0) return;
                onConfirmItems(checkedNames, true);
                handleReset();
                onClose();
              }}
              disabled={checkedNames.length === 0 || isScanning}
              className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
            >
              افزودن به صف و شروع جستجوی یکی‌یکی ({checkedNames.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
