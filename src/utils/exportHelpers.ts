import type {
  EnrichedProduct,
  EnrichmentSettings,
  LongDescFormat,
} from "../types/product.ts";
import { getWebpDataUrlBackup } from "./webpBackupDb.ts";

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function csvEscape(value: string): string {
  const safe = (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (safe.includes('"') || safe.includes(",") || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadProductsCsv(
  products: EnrichedProduct[],
  longDescFormat: LongDescFormat
): void {
  const headers = [
    "Slug",
    "Title_FA",
    "Title_EN",
    "Brand",
    "Category",
    "Model_Code",
    "Short_Description",
    "Long_Description",
    "Specs",
    "WebP_Files",
  ];
  const rows = [headers.join(",")];

  products.forEach((p, idx) => {
    const slugBase = p.slug || `product-${idx + 1}`;
    const selected = p.images.filter((i) => i.selected);
    const ordered = [...selected].sort((a, b) =>
      a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
    );
    const imageNames = ordered.map((_, i) => `images/${slugBase}-${i + 1}.webp`);
    const longBody =
      longDescFormat === "html" && p.longDescriptionHtml
        ? p.longDescriptionHtml
        : p.longDescription;
    const specsText = p.specs.map((s) => `${s.label}: ${s.value}`).join(" | ");

    rows.push(
      [
        slugBase,
        p.titleFa,
        p.titleEn,
        p.brand,
        p.category,
        p.modelCode,
        p.shortDescription,
        longBody,
        specsText,
        imageNames.join(" ; "),
      ]
        .map(csvEscape)
        .join(",")
    );
  });

  const blob = new Blob(["\uFEFF" + rows.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  triggerBlobDownload(blob, "kalasaz-products.csv");
}

export function downloadTextOnlyCsv(
  products: EnrichedProduct[],
  longDescFormat: LongDescFormat
): void {
  const headers = ["Name", "Short description", "Description"];
  const rows = [headers.join(",")];

  products.forEach((p) => {
    const shortLines = (p.shortDescription || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const shortBody =
      shortLines.length > 0
        ? `<ul>${shortLines.map((l) => `<li>${l}</li>`).join("")}</ul>`
        : p.shortDescription;

    const longBody =
      longDescFormat === "html" && p.longDescriptionHtml
        ? p.longDescriptionHtml
        : p.longDescription || p.longDescriptionHtml;

    rows.push(
      [p.titleFa || p.query, shortBody, longBody].map(csvEscape).join(",")
    );
  });

  const blob = new Blob(["\uFEFF" + rows.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  triggerBlobDownload(blob, "kalasaz-titles-descriptions.csv");
}

export async function downloadProductsJson(products: EnrichedProduct[]): Promise<void> {
  try {
    const res = await fetch("/api/export/json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products }),
    });
    if (res.ok) {
      const serverPayload = await res.json();
      const blob = new Blob([JSON.stringify(serverPayload, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      triggerBlobDownload(blob, "kalasaz-products.json");
      return;
    }
  } catch {
    // Fallback to client-side serialization below
  }

  const payload = products.map((p, idx) => {
    const slugBase = p.slug || `product-${idx + 1}`;
    const selected = p.images.filter((i) => i.selected);
    const ordered = [...selected].sort((a, b) =>
      a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
    );
    return {
      query: p.query,
      slug: slugBase,
      titleFa: p.titleFa,
      titleEn: p.titleEn,
      brand: p.brand,
      category: p.category,
      modelCode: p.modelCode,
      shortDescription: p.shortDescription,
      longDescription: p.longDescription,
      longDescriptionHtml: p.longDescriptionHtml,
      specs: p.specs,
      images: ordered.map((img, i) => ({
        id: img.id,
        url: img.url,
        filename: `${slugBase}-${i + 1}.webp`,
        width: img.width,
        height: img.height,
        sizeBytes: img.sizeBytes,
        sourceUrl: img.sourceUrl,
        sourceDomain: img.sourceDomain,
        selected: img.selected,
        isPrimary: img.isPrimary,
      })),
      sources: p.sources,
      searchQueries: p.searchQueries,
    };
  });

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  triggerBlobDownload(blob, "kalasaz-products.json");
}

async function shrinkDataUrlIfTooLarge(dataUrl: string, maxBytes = 850_000): Promise<string> {
  if (dataUrl.length <= maxBytes) return dataUrl;
  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1200;
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 800) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 800) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/webp", 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function shrinkImageFileToDataUrl(file: File, maxDim = 1600): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
  if (file.size <= 900_000) return rawDataUrl;

  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 800) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 800) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(rawDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => resolve(rawDataUrl);
    img.src = rawDataUrl;
  });
}

function extractRawItemsContainer(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.products)) return obj.products;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.catalog)) return obj.catalog;
    return [parsed];
  }
  return [];
}

async function slimDownLargeItemImages(
  item: unknown,
  settings?: Partial<EnrichmentSettings>
): Promise<unknown> {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const serializedLen = JSON.stringify(item).length;
  // If under 420 KB, no pre-splitting needed
  if (serializedLen <= 420_000) return item;

  const clone: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  const imgs = clone.images;
  if (!Array.isArray(imgs) || imgs.length === 0) return item;

  const slimmedImgs: unknown[] = [];
  for (let i = 0; i < imgs.length; i++) {
    const entry = imgs[i];
    if (entry && typeof entry === "object") {
      const imgObj = entry as Record<string, unknown>;
      const rawDataUrl =
        typeof imgObj.dataUrl === "string"
          ? imgObj.dataUrl
          : typeof imgObj.base64 === "string"
            ? imgObj.base64
            : "";

      if (rawDataUrl) {
        const normalizedDataUrl = rawDataUrl.startsWith("data:")
          ? rawDataUrl
          : `data:image/webp;base64,${rawDataUrl}`;
        const safeDataUrl = await shrinkDataUrlIfTooLarge(normalizedDataUrl, 750_000);

        // If external sourceUrl exists and item wasn't edited/uploaded locally, we don't even need huge base64 if upload isn't required,
        // otherwise pre-upload this single image cleanly so /api/import/json receives tiny ID reference.
        try {
          const uploadRes = await fetch("/api/images/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dataUrl: safeDataUrl,
              sourceUrl: typeof imgObj.sourceUrl === "string" ? imgObj.sourceUrl : "",
              sourceDomain: typeof imgObj.sourceDomain === "string" ? imgObj.sourceDomain : "upload",
              isPrimary: typeof imgObj.isPrimary === "boolean" ? imgObj.isPrimary : i === 0,
              selected: imgObj.selected !== false,
              fitMode: "inside",
              settings,
            }),
          });
          if (uploadRes.ok) {
            const upData = (await uploadRes.json()) as { image?: Record<string, unknown> };
            if (upData.image) {
              slimmedImgs.push(upData.image);
              continue;
            }
          }
        } catch {
          // If single upload fails, strip heavy base64 only if sourceUrl is http(s)
        }

        if (typeof imgObj.sourceUrl === "string" && /^https?:\/\//i.test(imgObj.sourceUrl)) {
          const { dataUrl: _d1, data_url: _d2, base64: _b, ...rest } = imgObj;
          slimmedImgs.push(rest);
          continue;
        }
      }
    }
    slimmedImgs.push(entry);
  }

  clone.images = slimmedImgs;
  return clone;
}

export async function importProductsFromJsonFile(
  file: File,
  settings?: Partial<EnrichmentSettings>,
  onProgress?: (processed: number, total: number) => void
): Promise<{ products: EnrichedProduct[]; restoredImagesCount: number }> {
  const rawText = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("فایل انتخاب‌شده ساختار JSON معتبر ندارد.");
  }

  const rawItems = extractRawItemsContainer(parsed);
  if (rawItems.length === 0) {
    throw new Error("فایل JSON معتبر نیست یا هیچ کالایی در آن پیدا نشد.");
  }

  // Group into safe network-friendly chunks (max 2 items AND max 450 KB per request)
  const MAX_CHUNK_ITEMS = 2;
  const MAX_CHUNK_BYTES = 450_000;

  const slimItems: unknown[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    onProgress?.(i, rawItems.length);
    slimItems.push(await slimDownLargeItemImages(rawItems[i], settings));
  }

  const chunks: unknown[][] = [];
  let currentChunk: unknown[] = [];
  let currentBytes = 0;

  for (const item of slimItems) {
    const itemBytes = JSON.stringify(item).length;
    if (
      currentChunk.length > 0 &&
      (currentChunk.length >= MAX_CHUNK_ITEMS || currentBytes + itemBytes > MAX_CHUNK_BYTES)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(item);
    currentBytes += itemBytes;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const allProducts: EnrichedProduct[] = [];
  let totalRestored = 0;
  let processedItems = 0;
  const skipAutoSearch = chunks.length > 2;

  for (const chunk of chunks) {
    let res: Response;
    try {
      res = await fetch("/api/import/json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: chunk, settings, skipAutoSearch }),
      });
    } catch {
      throw new Error("خطا در ارتباط با سرور هنگام ارسال فایل. لطفاً اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.");
    }

    const data = (await res.json().catch(() => ({}))) as {
      products?: EnrichedProduct[];
      restoredImagesCount?: number;
      error?: string;
    };

    if (!res.ok) {
      throw new Error(data.error || "خطا در خواندن و بارگذاری فایل JSON");
    }

    if (Array.isArray(data.products)) {
      allProducts.push(...data.products);
    }
    totalRestored += Number(data.restoredImagesCount) || 0;
    processedItems += chunk.length;
    onProgress?.(Math.min(processedItems, rawItems.length), rawItems.length);
  }

  if (allProducts.length === 0) {
    throw new Error("فایل JSON معتبر نیست یا هیچ کالای قابل خواندنی در آن پیدا نشد.");
  }

  return {
    products: allProducts,
    restoredImagesCount: totalRestored,
  };
}

export type WooPublishStatus = "draft" | "publish";
export type WooImageMode = "wp_media" | "source_url";

export interface WooCsvExportOptions {
  publishStatus: WooPublishStatus;
  imageMode: WooImageMode;
  wpImageBaseUrl?: string;
}

export function downloadWooCommerceCsv(
  products: EnrichedProduct[],
  options: WooCsvExportOptions
): void {
  const wooPublishCode = options.publishStatus === "publish" ? "1" : "-1";
  const rawBaseUrl = (options.wpImageBaseUrl || "").trim();
  const normalizedBaseUrl = rawBaseUrl
    ? rawBaseUrl.endsWith("/")
      ? rawBaseUrl
      : `${rawBaseUrl}/`
    : "";

  const wooHeaders = [
    "Type",
    "SKU",
    "Name",
    "Published",
    "Is featured?",
    "Visibility in catalog",
    "Short description",
    "Description",
    "In stock?",
    "Categories",
    "Images",
    "Attribute 1 name",
    "Attribute 1 value(s)",
    "Attribute 1 visible",
    "Attribute 1 global",
    "Attribute 2 name",
    "Attribute 2 value(s)",
    "Attribute 2 visible",
    "Attribute 2 global",
    "Attribute 3 name",
    "Attribute 3 value(s)",
    "Attribute 3 visible",
    "Attribute 3 global",
    "Attribute 4 name",
    "Attribute 4 value(s)",
    "Attribute 4 visible",
    "Attribute 4 global",
    "Attribute 5 name",
    "Attribute 5 value(s)",
    "Attribute 5 visible",
    "Attribute 5 global",
    "Attribute 6 name",
    "Attribute 6 value(s)",
    "Attribute 6 visible",
    "Attribute 6 global",
  ];

  const rows = [wooHeaders.join(",")];

  products.forEach((p, idx) => {
    const slugBase =
      (p.slug || `product-${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-") ||
      `product-${idx + 1}`;
    const selected = p.images.filter((i) => i.selected);
    const ordered = [...selected].sort((a, b) =>
      a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
    );

    const imageUrls: string[] = [];
    ordered.forEach((img, i) => {
      const fileName = `${slugBase}-${i + 1}.webp`;
      if (
        options.imageMode === "source_url" &&
        img.sourceUrl &&
        /^https?:\/\//i.test(img.sourceUrl)
      ) {
        imageUrls.push(img.sourceUrl);
      } else if (normalizedBaseUrl) {
        imageUrls.push(`${normalizedBaseUrl}${fileName}`);
      } else if (img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)) {
        imageUrls.push(img.sourceUrl);
      } else {
        imageUrls.push(`images/${fileName}`);
      }
    });

    const shortLines = (p.shortDescription || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const wooShortDescription =
      shortLines.length > 0
        ? `<ul>${shortLines.map((l) => `<li>${l}</li>`).join("")}</ul>`
        : p.shortDescription;

    const attrList: { name: string; val: string }[] = [];
    if (p.brand) attrList.push({ name: "برند", val: p.brand });
    for (const s of (p.specs || []).slice(0, 5)) {
      if (s.label && s.value) attrList.push({ name: s.label, val: s.value });
    }
    const attrCells: string[] = [];
    for (let a = 0; a < 6; a++) {
      const item = attrList[a];
      if (item) {
        attrCells.push(item.name, item.val, "1", "0");
      } else {
        attrCells.push("", "", "", "");
      }
    }

    rows.push(
      [
        "simple",
        p.modelCode || slugBase.toUpperCase(),
        p.titleFa || p.query,
        wooPublishCode,
        "0",
        "visible",
        wooShortDescription,
        p.longDescriptionHtml || p.longDescription,
        "1",
        p.category || "تجهیزات پزشکی",
        imageUrls.join(", "),
        ...attrCells,
      ]
        .map(csvEscape)
        .join(",")
    );
  });

  const blob = new Blob(["\uFEFF" + rows.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  triggerBlobDownload(blob, "kalasaz-woocommerce.csv");
}

export async function attachMissingWebpBackups(
  products: EnrichedProduct[]
): Promise<EnrichedProduct[]> {
  const uniqueCheckMap = new Map<string, Promise<string | null>>();

  const checkOrFetchBackup = (id: string, url: string): Promise<string | null> => {
    const existing = uniqueCheckMap.get(id);
    if (existing) return existing;

    const job = (async () => {
      try {
        if (url.startsWith("/api/webp/")) {
          const headRes = await fetch(url, { method: "HEAD" });
          if (headRes.ok) return null; // Already cached on server
        }
      } catch {
        // Proceed to IndexedDB check
      }
      return await getWebpDataUrlBackup(id);
    })();

    uniqueCheckMap.set(id, job);
    return job;
  };

  return await Promise.all(
    products.map(async (p) => {
      const updatedImages = await Promise.all(
        (p.images || []).map(async (img) => {
          if (img.selected === false) return img;
          const imgWithData = img as typeof img & { dataUrl?: string };
          if (imgWithData.dataUrl) return img;
          const backupDataUrl = await checkOrFetchBackup(img.id, img.url);
          if (backupDataUrl) {
            return { ...img, dataUrl: backupDataUrl };
          }
          return img;
        })
      );
      return { ...p, images: updatedImages };
    })
  );
}

export async function downloadProductsZip(
  products: EnrichedProduct[],
  longDescFormat: LongDescFormat,
  wpImageBaseUrl?: string,
  wooOptions?: {
    wooPublishStatus?: WooPublishStatus;
    wooImageMode?: WooImageMode;
    settings?: Partial<EnrichmentSettings>;
  }
): Promise<number> {
  const preparedProducts = await attachMissingWebpBackups(products);

  const res = await fetch("/api/export/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      products: preparedProducts,
      longDescFormat,
      wpImageBaseUrl,
      wooPublishStatus: wooOptions?.wooPublishStatus,
      wooImageMode: wooOptions?.wooImageMode,
      settings: wooOptions?.settings,
    }),
  });

  if (!res.ok) {
    const errData = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errData.error || "خطا در ساخت فایل ZIP");
  }

  const exportedImagesHeader = Number(res.headers.get("X-Exported-Images-Count"));
  const blob = await res.blob();
  const filename =
    products.length === 1 && products[0].slug
      ? `${products[0].slug}-webp.zip`
      : "kalasaz-catalog-webp.zip";
  triggerBlobDownload(blob, filename);
  return Number.isFinite(exportedImagesHeader) ? exportedImagesHeader : 0;
}
