import React, { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileScan,
  FileUp,
  ImagePlus,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type {
  EnrichedProduct,
  EnrichmentSettings,
  ProductStatus,
  WebpImageAsset,
} from "../types/product.ts";
import {
  importProductsFromJsonFile,
  shrinkImageFileToDataUrl,
} from "../utils/exportHelpers.ts";

export interface QueueItemInput {
  query: string;
  seedUrl?: string;
  seedImage?: WebpImageAsset;
}

export function parseBulkLines(rawText: string): QueueItemInput[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Support "Name | URL" or Tab-separated from Excel ("Name\tURL")
      const pipeSplit = line.split(/\s*\|\s*|\t+/);
      if (pipeSplit.length >= 2) {
        const possibleUrl = pipeSplit.find((part) => /^https?:\/\//i.test(part.trim()));
        const nameParts = pipeSplit.filter((part) => part.trim() !== possibleUrl?.trim());
        const name = nameParts.join(" ").trim();
        if (possibleUrl) {
          return {
            query: name || possibleUrl.trim(),
            seedUrl: possibleUrl.trim(),
          };
        }
      }

      // Support standalone URL line (direct image URL or product page URL)
      if (/^https?:\/\/\S+$/i.test(line)) {
        let fallbackName = "شناسایی محصول از لینک";
        try {
          const urlObj = new URL(line);
          const lastSeg = decodeURIComponent(
            urlObj.pathname.split("/").filter(Boolean).pop() || ""
          )
            .replace(/\.[a-z0-9]{2,5}$/i, "")
            .replace(/[-_]+/g, " ")
            .trim();
          if (lastSeg && lastSeg.length > 2) {
            fallbackName = lastSeg;
          }
        } catch {
          // keep default
        }
        return {
          query: fallbackName,
          seedUrl: line,
        };
      }

      return { query: line };
    });
}

interface ProductQueueSidebarProps {
  products: EnrichedProduct[];
  settings: EnrichmentSettings;
  selectedId: string | null;
  isBatchRunning: boolean;
  onSelectProduct: (id: string) => void;
  onAddProducts: (items: QueueItemInput[], autoStart?: boolean) => void;
  onImportProducts: (imported: EnrichedProduct[]) => void;
  onStartBatch: () => void;
  onStopBatch: () => void;
  onDeleteProduct: (id: string) => void;
  onClearCompleted: () => void;
  onOpenScanner: () => void;
}

const MEDICAL_SAMPLE_PRODUCTS = [
  "فشارسنج دیجیتال بازویی بیورر BM28",
  "پالس اکسیمتر انگشتی یوول YX306",
  "گوشی پزشکی لیتمن کلاسیک ۳ (3M Littmann Classic III)",
  "تب‌سنج لیزری غیرتماسی بیورر FT85",
];

export const ProductQueueSidebar: React.FC<ProductQueueSidebarProps> = ({
  products,
  settings,
  selectedId,
  isBatchRunning,
  onSelectProduct,
  onAddProducts,
  onImportProducts,
  onStartBatch,
  onStopBatch,
  onDeleteProduct,
  onClearCompleted,
  onOpenScanner,
}) => {
  const [bulkInput, setBulkInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProductStatus>("all");
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchImagesInputRef = useRef<HTMLInputElement>(null);

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseBulkLines(bulkInput);
    if (parsed.length === 0) return;
    onAddProducts(parsed, false);
    setBulkInput("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const isJson =
      file.name.toLowerCase().endsWith(".json") ||
      file.type.toLowerCase().includes("json");

    if (isJson) {
      setIsUploadingImages(true);
      setUploadStatusText("در حال بارگذاری فایل JSON...");
      try {
        const { products: imported, restoredImagesCount } =
          await importProductsFromJsonFile(file, settings, (done, total) => {
            setUploadStatusText(`در حال آپلود JSON (${done} از ${total} کالا)...`);
          });
        if (imported.length > 0) {
          onImportProducts(imported);
          const imgNote =
            restoredImagesCount > 0 ? ` (${restoredImagesCount} تصویر بازیابی شد)` : "";
          setUploadStatusText(`${imported.length} کالا از JSON اضافه شد${imgNote}.`);
        } else {
          setUploadStatusText("کالایی در فایل JSON یافت نشد.");
        }
      } catch (err) {
        setUploadStatusText(
          err instanceof Error ? err.message : "خطا در خواندن فایل JSON"
        );
      } finally {
        setIsUploadingImages(false);
        setTimeout(() => setUploadStatusText(null), 4000);
      }
      return;
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const items: QueueItemInput[] = [];

    for (const line of lines) {
      const cols = line
        .split(/,|\t/)
        .map((c) => c.replace(/^"|"$/g, "").trim())
        .filter(Boolean);
      if (cols.length === 0) continue;
      if (/^(name|title|نام|نام کالا)$/i.test(cols[0])) continue;

      const urlCol = cols.find((c) => /^https?:\/\//i.test(c));
      const textCol = cols.find((c) => c !== urlCol);
      if (urlCol) {
        items.push({
          query: textCol || urlCol,
          seedUrl: urlCol,
        });
      } else if (textCol) {
        items.push({ query: textCol });
      }
    }

    if (items.length > 0) {
      onAddProducts(items, false);
    }
  };

  const handleBatchImageUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploadingImages(true);
    setUploadStatusText(`در حال آماده‌سازی ${files.length} تصویر...`);

    const createdItems: QueueItemInput[] = [];
    const fileArray = Array.from(files).filter((f) => f.type.startsWith("image/"));

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      setUploadStatusText(`تبدیل تصویر ${i + 1} از ${fileArray.length} به WebP...`);
      try {
        const dataUrl = await shrinkImageFileToDataUrl(file);
        const res = await fetch("/api/images/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl, filename: file.name, settings }),
        });
        if (res.ok) {
          const data = (await res.json()) as { image?: WebpImageAsset };
          if (data.image) {
            const cleanFilename = file.name
              .replace(/\.[a-z0-9]{2,5}$/i, "")
              .replace(/[-_]+/g, " ")
              .trim();
            // Ignore generic camera filenames like IMG_1024 or photo_12
            const isGeneric = /^(img|dsc|photo|image|pic|screenshot|whatsapp)[-_ ]?\d*$/i.test(
              cleanFilename
            );
            createdItems.push({
              query: isGeneric || cleanFilename.length < 3 ? "شناسایی محصول از تصویر" : cleanFilename,
              seedImage: { ...data.image, isPrimary: true, selected: true },
            });
          }
        }
      } catch {
        // Continue remaining images
      }
    }

    if (createdItems.length > 0) {
      onAddProducts(createdItems, false);
      setUploadStatusText(`${createdItems.length} کالا از روی عکس به صف اضافه شد.`);
      setTimeout(() => setUploadStatusText(null), 3500);
    } else {
      setUploadStatusText("تصویر معتبری برای افزودن به صف یافت نشد.");
      setTimeout(() => setUploadStatusText(null), 3500);
    }
    setIsUploadingImages(false);
  };

  const handleInsertSamples = () => {
    setBulkInput((prev) =>
      prev.trim()
        ? `${prev.trim()}\n${MEDICAL_SAMPLE_PRODUCTS.join("\n")}`
        : MEDICAL_SAMPLE_PRODUCTS.join("\n")
    );
  };

  const pendingCount = products.filter((p) => p.status === "pending" || p.status === "error").length;
  const doneCount = products.filter((p) => p.status === "done").length;
  const processingCount = products.filter((p) => p.status === "processing").length;

  const filteredProducts = products.filter((p) => {
    const matchesStatus = statusFilter === "all" || p.status === statusFilter;
    const q = searchFilter.trim().toLowerCase();
    const matchesSearch =
      !q ||
      p.query.toLowerCase().includes(q) ||
      p.titleFa.toLowerCase().includes(q) ||
      p.titleEn.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q);
    return matchesStatus && matchesSearch;
  });

  const renderStatusLabel = (status: ProductStatus) => {
    switch (status) {
      case "done":
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            تکمیل‌شده
          </span>
        );
      case "processing":
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 whitespace-nowrap">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            در حال جستجو
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 whitespace-nowrap">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            خطا
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 whitespace-nowrap">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            در صف
          </span>
        );
    }
  };

  return (
    <aside className="w-full lg:w-[355px] shrink-0 bg-white border-b lg:border-b-0 lg:border-l border-slate-200 flex flex-col lg:h-[calc(100vh-57px)]">
      {/* Bulk Input Area */}
      <div className="p-4 border-b border-slate-200 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">ورود لیست کالا یا عکس</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleInsertSamples}
              className="text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              نمونه پزشکی
            </button>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              CSV/TXT/JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,.json,application/json"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>
        </div>

        <form onSubmit={handleAddSubmit} className="space-y-2.5">
          <textarea
            value={bulkInput}
            onChange={(e) => setBulkInput(e.target.value)}
            rows={4}
            placeholder="نام کالا، یا «نام | لینک عکس/صفحه»، یا لیست لینک عکس‌ها (هر مورد در یک خط):&#10;فشارسنج بیورر BM28&#10;پالس اکسیمتر | https://.../photo.jpg&#10;https://.../stethoscope.png"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/15 resize-y min-h-[88px] leading-relaxed"
          />

          {/* Batch Image Upload & A4 Scanner Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onOpenScanner}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-2.5 py-2 text-xs font-medium text-blue-800 hover:bg-blue-100/80 transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileScan className="w-3.5 h-3.5 shrink-0" />
              اسکن برگه A4
            </button>

            <button
              type="button"
              onClick={() => batchImagesInputRef.current?.click()}
              disabled={isUploadingImages}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-slate-50/80 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:border-slate-400 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
            >
              {isUploadingImages ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700 shrink-0" />
              ) : (
                <ImagePlus className="w-3.5 h-3.5 text-slate-600 shrink-0" />
              )}
              آپلود عکس‌ها
            </button>
            <input
              ref={batchImagesInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                void handleBatchImageUpload(e.target.files);
                e.target.value = "";
              }}
              className="hidden"
            />
          </div>

          {uploadStatusText && (
            <p className="text-[11px] font-medium text-blue-700">{uploadStatusText}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!bulkInput.trim()}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              افزودن به صف
            </button>

            {isBatchRunning ? (
              <button
                type="button"
                onClick={onStopBatch}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5" />
                توقف پردازش
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartBatch}
                disabled={pendingCount === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                پردازش صف ({pendingCount})
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Queue Controls & Filter */}
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 space-y-2.5">
        <div className="flex items-center justify-between text-xs text-slate-600 tabular-nums">
          <span>
            کل: <strong className="text-slate-900">{products.length}</strong>
            <span className="mx-1.5 text-slate-300">·</span>
            آماده: <strong className="text-emerald-700">{doneCount}</strong>
            {processingCount > 0 && (
              <>
                <span className="mx-1.5 text-slate-300">·</span>
                فعال: <strong className="text-blue-700">{processingCount}</strong>
              </>
            )}
          </span>
          {doneCount > 0 && (
            <button
              type="button"
              onClick={onClearCompleted}
              className="text-xs text-slate-500 hover:text-red-700 transition-colors whitespace-nowrap cursor-pointer"
            >
              پاک‌کردن تکمیل‌شده‌ها
            </button>
          )}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="جستجو در صف..."
            className="w-full rounded-md border border-slate-200 bg-white pr-8 pl-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg overflow-x-auto">
          {(
            [
              { id: "all", label: "همه" },
              { id: "done", label: "آماده" },
              { id: "pending", label: "در صف" },
              { id: "error", label: "خطا" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`flex-1 px-2 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                statusFilter === tab.id
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {filteredProducts.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            {products.length === 0
              ? "هنوز کالایی به صف اضافه نشده است."
              : "کالایی با این فیلتر یافت نشد."}
          </div>
        ) : (
          filteredProducts.map((item) => {
            const isSelected = item.id === selectedId;
            const selectedImgCount = item.images.filter((i) => i.selected).length;
            const thumb = item.images[0] || item.seedImage;

            return (
              <div
                key={item.id}
                onClick={() => onSelectProduct(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectProduct(item.id);
                  }
                }}
                className={`group px-3.5 py-2.5 flex items-center justify-between gap-2.5 cursor-pointer transition-colors ${
                  isSelected ? "bg-blue-50/70" : "hover:bg-slate-50"
                }`}
              >
                {thumb && (
                  <div className="w-9 h-9 rounded-md border border-slate-200 bg-white shrink-0 overflow-hidden flex items-center justify-center">
                    <img
                      src={thumb.url}
                      alt={item.titleFa || item.query}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-contain p-0.5"
                    />
                  </div>
                )}

                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-xs font-medium truncate ${
                        isSelected ? "text-blue-950" : "text-slate-900"
                      }`}
                    >
                      {item.status === "done" && item.titleFa ? item.titleFa : item.query}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
                    {renderStatusLabel(item.status)}
                    {item.status === "done" && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{selectedImgCount} WebP</span>
                        {item.brand && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{item.brand}</span>
                          </>
                        )}
                      </>
                    )}
                    {item.status === "pending" && item.seedImage && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>دارای عکس اولیه</span>
                      </>
                    )}
                    {item.status === "pending" && item.seedUrl && !item.seedImage && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>دارای لینک</span>
                      </>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProduct(item.id);
                  }}
                  title="حذف از صف"
                  className="p-1.5 rounded-md text-slate-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-700 hover:bg-red-50 transition-all shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
