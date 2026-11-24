import React, { useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  FolderArchive,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Search,
  ShoppingBag,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  EnrichedProduct,
  EnrichmentSettings,
  WebpImageAsset,
} from "../types/product.ts";
import {
  downloadProductsCsv,
  downloadProductsJson,
  downloadProductsZip,
  downloadTextOnlyCsv,
  importProductsFromJsonFile,
} from "../utils/exportHelpers.ts";
import { WooCommerceModal } from "./WooCommerceModal.tsx";

interface CatalogTableViewProps {
  products: EnrichedProduct[];
  settings: EnrichmentSettings;
  onInspectProduct: (id: string) => void;
  onDeleteProduct: (id: string) => void;
  onImportProducts: (imported: EnrichedProduct[]) => EnrichedProduct[];
  onUpdateProduct: (id: string, patch: Partial<EnrichedProduct>) => void;
}

export const CatalogTableView: React.FC<CatalogTableViewProps> = ({
  products,
  settings,
  onInspectProduct,
  onDeleteProduct,
  onImportProducts,
  onUpdateProduct,
}) => {
  const [search, setSearch] = useState("");
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [isWooModalOpen, setIsWooModalOpen] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const readyProducts = products.filter((p) => p.status === "done");
  const missingImageProducts = products.filter(
    (p) => p.images.length === 0 && Boolean(p.titleFa || p.titleEn || p.query)
  );
  const filtered = products.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      p.query.toLowerCase().includes(q) ||
      p.titleFa.toLowerCase().includes(q) ||
      p.titleEn.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q)
    );
  });

  const handleZipExport = async () => {
    if (readyProducts.length === 0) return;
    setIsExportingZip(true);
    setExportError(null);
    try {
      await downloadProductsZip(
        readyProducts,
        settings.longDescFormat,
        settings.wpImageBaseUrl,
        { settings }
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "خطا در آماده‌سازی فایل ZIP");
    } finally {
      setIsExportingZip(false);
    }
  };

  const backfillMissingImages = async (targets: EnrichedProduct[]) => {
    if (targets.length === 0 || backfillProgress) return;
    let recoveredImages = 0;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      setBackfillProgress(`در حال یافتن عکس WebP (${i + 1} از ${targets.length}): ${target.titleFa || target.query}...`);
      try {
        const res = await fetch("/api/products/more-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productName: target.titleFa || target.titleEn || target.query,
            brand: target.brand,
            settings,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { images?: WebpImageAsset[] };
          if (Array.isArray(data.images) && data.images.length > 0) {
            onUpdateProduct(target.id, { images: data.images });
            recoveredImages += data.images.length;
          }
        }
      } catch {
        // Continue with next product
      }
    }

    setBackfillProgress(null);
    if (recoveredImages > 0) {
      setImportNotice(`${recoveredImages} تصویر WebP جدید برای کالاهای بدون تصویر پیدا و اضافه شد.`);
    }
  };

  const handleJsonUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setIsImportingJson(true);
    setImportProgress("در حال آماده‌سازی فایل...");
    setExportError(null);
    setImportNotice(null);
    try {
      const { products: imported, restoredImagesCount } = await importProductsFromJsonFile(
        file,
        settings,
        (done, total) => {
          setImportProgress(`در حال آپلود و پردازش (${done} از ${total} کالا)...`);
        }
      );
      if (imported.length === 0) {
        setExportError("هیچ کالایی در فایل JSON یافت نشد.");
        return;
      }
      const inserted = onImportProducts(imported);
      const stillMissing = inserted.filter(
        (p) => p.images.length === 0 && Boolean(p.titleFa || p.titleEn || p.query)
      );
      const imageNote =
        restoredImagesCount > 0
          ? ` (${restoredImagesCount} تصویر به WebP بازیابی شد)`
          : "";
      setImportNotice(`${inserted.length} کالا از فایل JSON به جدول اضافه شد${imageNote}.`);

      if (stillMissing.length > 0) {
        void backfillMissingImages(stillMissing);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "خطا در بارگذاری فایل JSON");
    } finally {
      setIsImportingJson(false);
      setImportProgress(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Header & Export Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-slate-900">جدول کاتالوگ و خروجی یکجا</h1>
            <p className="text-xs text-slate-500 tabular-nums">
              {readyProducts.length} کالای تکمیل‌شده از مجموع {products.length} کالا آماده ورود به سایت است
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleJsonUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => jsonInputRef.current?.click()}
              disabled={isImportingJson}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2 text-xs font-medium text-blue-800 hover:bg-blue-100/80 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isImportingJson ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              {isImportingJson ? importProgress || "در حال خواندن JSON..." : "آپلود JSON"}
            </button>
            {missingImageProducts.length > 0 && (
              <button
                type="button"
                onClick={() => void backfillMissingImages(missingImageProducts)}
                disabled={Boolean(backfillProgress)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                {backfillProgress ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="w-3.5 h-3.5" />
                )}
                یافتن عکس ({missingImageProducts.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => downloadTextOnlyCsv(readyProducts, settings.longDescFormat)}
              disabled={readyProducts.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              CSV فقط عنوان و توضیحات
            </button>
            <button
              type="button"
              onClick={() => downloadProductsCsv(readyProducts, settings.longDescFormat)}
              disabled={readyProducts.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              دانلود CSV اکسل
            </button>
            <button
              type="button"
              onClick={() => void downloadProductsJson(readyProducts)}
              disabled={readyProducts.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              دانلود JSON
            </button>
            <button
              type="button"
              onClick={() => setIsWooModalOpen(true)}
              disabled={readyProducts.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              ارسال / خروجی ووکامرس
            </button>
            <button
              type="button"
              onClick={handleZipExport}
              disabled={readyProducts.length === 0 || isExportingZip}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isExportingZip ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderArchive className="w-3.5 h-3.5" />
              )}
              دانلود پکیج کامل ZIP (عکس‌های WebP + اکسل + ووکامرس)
            </button>
          </div>
        </div>

        {backfillProgress && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-800 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span>{backfillProgress}</span>
          </div>
        )}

        {importNotice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800 flex items-center justify-between gap-2">
            <span>{importNotice}</span>
            <button
              type="button"
              onClick={() => setImportNotice(null)}
              className="text-emerald-700 hover:text-emerald-900 font-medium cursor-pointer"
            >
              بستن
            </button>
          </div>
        )}

        {exportError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700">
            {exportError}
          </div>
        )}

        {/* Search Input */}
        <div className="relative max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجو بر اساس نام، برند یا دسته‌بندی..."
            className="w-full rounded-lg border border-slate-200 bg-white pr-9 pl-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
          />
        </div>

        {/* Data Table */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-10 text-center space-y-3">
              <p className="text-sm text-slate-500">
                {products.length === 0
                  ? "هنوز هیچ کالایی ثبت نشده است. از بخش میز کار کالاهای خود را اضافه کنید یا فایل JSON قبلی را آپلود نمایید."
                  : "موردی مطابق جستجوی شما یافت نشد."}
              </p>
              {products.length === 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => jsonInputRef.current?.click()}
                    disabled={isImportingJson}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 text-blue-700" />
                    آپلود فایل JSON در جدول
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 w-16">تصویر</th>
                    <th className="py-3 px-4">نام محصول</th>
                    <th className="py-3 px-4">برند و دسته</th>
                    <th className="py-3 px-4">توضیح کوتاه</th>
                    <th className="py-3 px-4 text-center">WebP</th>
                    <th className="py-3 px-4">وضعیت</th>
                    <th className="py-3 px-4 w-24 text-left">عملیات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filtered.map((p) => {
                    const primaryImg =
                      p.images.find((i) => i.isPrimary && i.selected) ||
                      p.images.find((i) => i.selected) ||
                      p.images[0];
                    const selectedCount = p.images.filter((i) => i.selected).length;

                    return (
                      <tr
                        key={p.id}
                        onClick={() => onInspectProduct(p.id)}
                        className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                      >
                        <td className="py-2.5 px-4">
                          <div className="w-11 h-11 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden">
                            {primaryImg ? (
                              <img
                                src={primaryImg.url}
                                alt={p.titleFa || p.query}
                                referrerPolicy="no-referrer"
                                onError={(e) => {
                                  const imgEl = e.currentTarget;
                                  if (
                                    primaryImg.sourceUrl &&
                                    /^https?:\/\//i.test(primaryImg.sourceUrl) &&
                                    imgEl.src !== primaryImg.sourceUrl
                                  ) {
                                    imgEl.src = primaryImg.sourceUrl;
                                  }
                                }}
                                className="w-full h-full object-contain p-0.5"
                              />
                            ) : (
                              <ImageIcon className="w-4 h-4 text-slate-400" />
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 max-w-[260px]">
                          <div className="font-semibold text-slate-900 truncate">
                            {p.titleFa || p.query}
                          </div>
                          {p.titleEn && (
                            <div className="text-[11px] text-slate-400 font-mono truncate" dir="ltr">
                              {p.titleEn}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">
                          {p.brand || "—"}
                          {p.category ? ` · ${p.category}` : ""}
                        </td>
                        <td className="py-2.5 px-4 max-w-[280px] text-slate-600 truncate">
                          {p.shortDescription || "—"}
                        </td>
                        <td className="py-2.5 px-4 text-center font-mono tabular-nums text-slate-900">
                          {selectedCount}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {p.status === "done" ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              آماده
                            </span>
                          ) : p.status === "processing" ? (
                            <span className="text-blue-700 font-medium">در حال جستجو</span>
                          ) : p.status === "error" ? (
                            <span className="text-red-700 font-medium">خطا</span>
                          ) : (
                            <span className="text-slate-500">در صف</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-left">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteProduct(p.id);
                            }}
                            title="حذف"
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <WooCommerceModal
        isOpen={isWooModalOpen}
        products={readyProducts}
        settings={settings}
        onClose={() => setIsWooModalOpen(false)}
      />
    </div>
  );
};
