import React, { useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Crop,
  Download,
  ExternalLink,
  FileScan,
  FolderArchive,
  Globe,
  Image as ImageIcon,
  ImagePlus,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  EnrichedProduct,
  EnrichmentSettings,
  WebpImageAsset,
} from "../types/product.ts";
import {
  downloadProductsZip,
  formatBytes,
  shrinkImageFileToDataUrl,
} from "../utils/exportHelpers.ts";
import { ImageEditorModal } from "./ImageEditorModal.tsx";
import { parseBulkLines, type QueueItemInput } from "./ProductQueueSidebar.tsx";

interface ProductInspectorProps {
  product: EnrichedProduct | null;
  settings: EnrichmentSettings;
  onUpdateProduct: (id: string, patch: Partial<EnrichedProduct>) => void;
  onRetryProduct: (id: string) => void;
  onDeleteProduct: (id: string) => void;
  onQuickAddAndRun: (items: QueueItemInput[]) => void;
  onOpenScanner: () => void;
}

const WebpImageCard: React.FC<{
  img: WebpImageAsset;
  slug: string;
  index: number;
  onOpenEditor: () => void;
  onToggleSelect: () => void;
  onSetPrimary: () => void;
  onRemove: () => void;
}> = ({ img, slug, index, onOpenEditor, onToggleSelect, onSetPrimary, onRemove }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const [useSourceFallback, setUseSourceFallback] = useState(false);

  const downloadFilename = `${slug || "product"}-${index + 1}.webp`;
  const activeSrc =
    useSourceFallback && img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)
      ? img.sourceUrl
      : img.url;

  return (
    <div
      className={`group rounded-lg border bg-white overflow-hidden transition-colors ${
        img.selected
          ? img.isPrimary
            ? "border-blue-600 ring-1 ring-blue-600/20"
            : "border-slate-300"
          : "border-slate-200 opacity-60"
      }`}
    >
      {/* Image Canvas (click opens lightbox / crop & logo remover) */}
      <div
        onClick={onOpenEditor}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenEditor();
          }
        }}
        title="کلیک کنید: بزرگ‌نمایی، برش و حذف لوگو"
        className="relative aspect-square bg-slate-50 border-b border-slate-100 flex items-center justify-center overflow-hidden cursor-zoom-in"
      >
        {imgFailed ? (
          <div className="flex flex-col items-center justify-center gap-1.5 p-4 text-center text-slate-400">
            <ImageIcon className="w-7 h-7" />
            <span className="text-xs">پیش‌نمایش در دسترس نیست</span>
          </div>
        ) : (
          <img
            src={activeSrc}
            alt={`${slug} - ${index + 1}`}
            referrerPolicy="no-referrer"
            onError={() => {
              if (!useSourceFallback && img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)) {
                setUseSourceFallback(true);
              } else {
                setImgFailed(true);
              }
            }}
            className="w-full h-full object-contain p-2 transition-transform duration-150 group-hover:scale-[1.03]"
          />
        )}

        {/* Top-right selection checkbox */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          title={img.selected ? "حذف از خروجی" : "افزودن به خروجی"}
          className={`absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center border text-xs transition-colors cursor-pointer ${
            img.selected
              ? "bg-blue-700 border-blue-700 text-white"
              : "bg-white/90 border-slate-300 text-slate-500 hover:border-slate-400"
          }`}
        >
          {img.selected && <Check className="w-3.5 h-3.5" />}
        </button>

        {/* Top-left quick actions */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenEditor();
            }}
            title="برش و حذف لوگو"
            className="p-1.5 rounded-md border border-slate-200 bg-white/90 text-slate-600 hover:text-blue-700 hover:border-blue-300 transition-colors cursor-pointer"
          >
            <Crop className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSetPrimary();
            }}
            title={img.isPrimary ? "تصویر شاخص" : "انتخاب به عنوان تصویر شاخص"}
            className={`p-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
              img.isPrimary
                ? "bg-amber-50 border-amber-300 text-amber-700"
                : "bg-white/90 border-slate-200 text-slate-500 hover:text-amber-600"
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${img.isPrimary ? "fill-amber-500" : ""}`} />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="حذف تصویر"
            className="p-1.5 rounded-md border border-slate-200 bg-white/90 text-slate-500 hover:text-red-700 hover:border-red-200 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Unboxed Tabular Metadata & Download Bar */}
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 font-mono tabular-nums">
          <span>
            {img.width}×{img.height}
            <span className="mx-1 text-slate-300">·</span>
            {formatBytes(img.sizeBytes)}
          </span>
          <span className="truncate max-w-[100px] font-sans" title={img.sourceDomain}>
            {img.isPrimary ? "شاخص" : img.sourceDomain}
          </span>
        </div>

        <a
          href={`${img.url}?download=1&name=${encodeURIComponent(downloadFilename)}`}
          download={downloadFilename}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" />
          دانلود WebP
        </a>
      </div>
    </div>
  );
};

export const ProductInspector: React.FC<ProductInspectorProps> = ({
  product,
  settings,
  onUpdateProduct,
  onRetryProduct,
  onDeleteProduct,
  onQuickAddAndRun,
  onOpenScanner,
}) => {
  const [quickInput, setQuickInput] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [shortDescMode, setShortDescMode] = useState<"options" | "raw">("options");
  const [descMode, setDescMode] = useState<"structured" | "html">("structured");
  const [customUrl, setCustomUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [isSearchingMore, setIsSearchingMore] = useState(false);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [imageFeedback, setImageFeedback] = useState<string | null>(null);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Clipboard blocked
    }
  };

  // Empty State (No product selected)
  if (!product) {
    return (
      <div className="flex-1 overflow-y-auto p-6 lg:p-10">
        <div className="max-w-3xl mx-auto py-8 space-y-8">
          <div className="space-y-3">
            <h1 className="text-2xl lg:text-3xl font-bold text-slate-900 tracking-tight [text-wrap:balance]">
              تکمیل خودکار اطلاعات تجهیزات پزشکی و تصاویر WebP
            </h1>
            <p className="text-sm lg:text-base text-slate-600 leading-relaxed max-w-2xl">
              لیست نام کالاهای پزشکی، لینک عکس‌ها یا لینک صفحات محصول را وارد کنید (یا از ستون کناری دسته‌ای عکس آپلود کنید). کالاساز سایت رسمی برندها و فروشگاه‌های تجهیزات پزشکی را جستجو کرده و عنوان، توضیح کوتاه، توضیح بلند ووکامرس، مشخصات فنی و تصاویر WebP را آماده می‌کند.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = parseBulkLines(quickInput);
              if (parsed.length === 0) return;
              onQuickAddAndRun(parsed);
              setQuickInput("");
            }}
            className="bg-white rounded-xl border border-slate-200 p-5 space-y-4"
          >
            <label className="block text-sm font-medium text-slate-900">
              شروع سریع: نام کالا، «نام | لینک عکس/صفحه» یا لیست لینک عکس‌ها (هر مورد در یک خط)
            </label>
            <textarea
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              rows={4}
              placeholder="مثال:&#10;فشارسنج دیجیتال بازویی بیورر BM28&#10;پالس اکسیمتر انگشتی یوول YX306 | https://.../yx306.jpg&#10;گوشی پزشکی لیتمن کلاسیک ۳"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/15"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>مناسب ووکامرس آرال هلث</span>
                <span aria-hidden="true">·</span>
                <span>پشتیبانی از لیست عکس و لینک</span>
                <span aria-hidden="true">·</span>
                <span>خروجی WebP</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenScanner}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileScan className="w-4 h-4 text-blue-700" />
                  اسکن برگه A4
                </button>
                <button
                  type="submit"
                  disabled={!quickInput.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  افزودن و شروع جستجو
                </button>
              </div>
            </div>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-2 border-t border-slate-200">
            <div className="space-y-1.5">
              <div className="text-xs font-mono text-slate-400 tabular-nums">01</div>
              <h3 className="text-sm font-semibold text-slate-900">لیست نام، لینک یا عکس</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                چندین عکس کالا را همزمان آپلود کنید یا لیست لینک و نام کالا را از اکسل کپی کنید.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-mono text-slate-400 tabular-nums">02</div>
              <h3 className="text-sm font-semibold text-slate-900">جستجو در سایت برندهای پزشکی</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                شناسایی مدل دقیق از روی نام یا عکس، دریافت دقت سنجش، کاربرد بالینی و تصاویر اصلی.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-mono text-slate-400 tabular-nums">03</div>
              <h3 className="text-sm font-semibold text-slate-900">خروجی آماده ووکامرس + WebP</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                فایل CSV استاندارد ووکامرس همراه با تمام عکس‌های کادر سفید WebP در یک فایل ZIP.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Pending State
  if (product.status === "pending") {
    return (
      <div className="flex-1 overflow-y-auto p-6 lg:p-10">
        <div className="max-w-3xl mx-auto bg-white rounded-xl border border-slate-200 p-8 text-center space-y-4">
          {product.seedImage && (
            <div className="w-28 h-28 mx-auto rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
              <img
                src={product.seedImage.url}
                alt={product.query}
                className="w-full h-full object-contain p-1.5"
              />
            </div>
          )}
          <h2 className="text-lg font-semibold text-slate-900">{product.query}</h2>
          {product.seedUrl && (
            <p className="text-xs font-mono text-slate-400 truncate max-w-md mx-auto" dir="ltr">
              {product.seedUrl}
            </p>
          )}
          <p className="text-sm text-slate-600">
            این کالا در صف انتظار است. می‌توانید پردازش تک‌تک یا پردازش دسته‌جمعی کل صف را شروع کنید.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onRetryProduct(product.id)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              شروع جستجوی این کالا
            </button>
            <button
              type="button"
              onClick={() => onDeleteProduct(product.id)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            >
              حذف
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Processing Skeleton State
  if (product.status === "processing") {
    return (
      <div className="flex-1 overflow-y-auto p-6 lg:p-8">
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6 flex items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-blue-700 text-sm font-medium">
                <Loader2 className="w-4 h-4 animate-spin" />
                در حال جستجوی سایت برند، فروشگاه‌ها و تبدیل تصاویر به WebP...
              </div>
              <h2 className="text-lg font-bold text-slate-900">{product.query}</h2>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
              <div className="h-5 w-2/3 bg-slate-200 rounded animate-pulse" />
              <div className="h-20 w-full bg-slate-100 rounded animate-pulse" />
              <div className="h-44 w-full bg-slate-100 rounded animate-pulse" />
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
              <div className="h-5 w-1/2 bg-slate-200 rounded animate-pulse" />
              <div className="grid grid-cols-2 gap-3">
                <div className="aspect-square bg-slate-100 rounded-lg animate-pulse" />
                <div className="aspect-square bg-slate-100 rounded-lg animate-pulse" />
                <div className="aspect-square bg-slate-100 rounded-lg animate-pulse" />
                <div className="aspect-square bg-slate-100 rounded-lg animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error State
  if (product.status === "error") {
    return (
      <div className="flex-1 overflow-y-auto p-6 lg:p-10">
        <div className="max-w-2xl mx-auto bg-white rounded-xl border border-red-200 p-6 space-y-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900">{product.query}</h2>
              <p className="text-sm text-red-700">
                {product.errorMessage || "در جستجوی اطلاعات این کالا خطایی رخ داد."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => onRetryProduct(product.id)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              تلاش مجدد
            </button>
            <button
              type="button"
              onClick={() => onDeleteProduct(product.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            >
              حذف کالا
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Handlers for Populated State
  const handleExtractFromUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrl.trim()) return;
    setIsFetchingUrl(true);
    setImageFeedback(null);
    try {
      const res = await fetch("/api/images/from-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: customUrl.trim(), settings }),
      });
      const data = (await res.json()) as { images?: WebpImageAsset[]; error?: string };
      if (!res.ok || !data.images) {
        setImageFeedback(data.error || "خطا در استخراج تصویر از لینک");
        return;
      }
      const nextImages = [...product.images, ...data.images];
      if (nextImages.length > 0 && !nextImages.some((i) => i.isPrimary)) {
        nextImages[0].isPrimary = true;
      }
      onUpdateProduct(product.id, { images: nextImages });
      setCustomUrl("");
      setImageFeedback(`${data.images.length} تصویر جدید به فرمت WebP اضافه شد.`);
    } catch (err) {
      setImageFeedback(err instanceof Error ? err.message : "خطای ارتباط با سرور");
    } finally {
      setIsFetchingUrl(false);
    }
  };

  const handleFindMoreImages = async () => {
    setIsSearchingMore(true);
    setImageFeedback(null);
    try {
      const res = await fetch("/api/products/more-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: product.titleEn || product.titleFa || product.query,
          brand: product.brand,
          settings,
        }),
      });
      const data = (await res.json()) as { images?: WebpImageAsset[]; error?: string };
      if (!res.ok || !data.images) {
        setImageFeedback(data.error || "تصویر بیشتری پیدا نشد.");
        return;
      }
      const existingSrcs = new Set(product.images.map((i) => i.sourceUrl));
      const fresh = data.images.filter((i) => !existingSrcs.has(i.sourceUrl));
      if (fresh.length === 0) {
        setImageFeedback("تصویر جدید متفاوتی در صفحات دیگر یافت نشد. می‌توانید از کادر زیر لینک دلخواه وارد کنید.");
        return;
      }
      const nextImages = [...product.images, ...fresh];
      if (!nextImages.some((i) => i.isPrimary)) {
        nextImages[0].isPrimary = true;
      }
      onUpdateProduct(product.id, { images: nextImages });
      setImageFeedback(`${fresh.length} تصویر جدید WebP یافت و اضافه شد.`);
    } catch (err) {
      setImageFeedback(err instanceof Error ? err.message : "خطا در جستجوی تصاویر");
    } finally {
      setIsSearchingMore(false);
    }
  };

  const handleManualImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setImageFeedback(null);
    const added: WebpImageAsset[] = [];

    for (const file of files) {
      const dataUrl = await shrinkImageFileToDataUrl(file);
      const res = await fetch("/api/images/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl, filename: file.name, settings }),
      });
      if (res.ok) {
        const data = (await res.json()) as { image?: WebpImageAsset };
        if (data.image) added.push(data.image);
      }
    }

    if (added.length > 0) {
      const nextImages = [...product.images, ...added];
      if (!nextImages.some((i) => i.isPrimary)) {
        nextImages[0].isPrimary = true;
      }
      onUpdateProduct(product.id, { images: nextImages });
      setImageFeedback(`${added.length} تصویر به WebP تبدیل و اضافه شد.`);
    } else {
      setImageFeedback("امکان تبدیل فایل‌های انتخابی وجود نداشت (حداقل ابعاد ۲۲۰×۲۲۰).");
    }
    e.target.value = "";
  };

  const handleDownloadSingleZip = async () => {
    setIsDownloadingZip(true);
    try {
      await downloadProductsZip(
        [product],
        settings.longDescFormat,
        settings.wpImageBaseUrl,
        { settings }
      );
    } catch (err) {
      setImageFeedback(err instanceof Error ? err.message : "خطا در ساخت ZIP");
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const selectedImagesCount = product.images.filter((i) => i.selected).length;

  return (
    <div className="flex-1 overflow-y-auto p-5 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Product Header Bar */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0 flex-1">
            <h1 className="text-xl font-bold text-slate-900 leading-snug">
              {product.titleFa || product.query}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
              {product.brand && <span>برند: {product.brand}</span>}
              {product.category && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>دسته: {product.category}</span>
                </>
              )}
              {product.modelCode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{product.modelCode}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{selectedImagesCount} تصویر WebP انتخاب‌شده</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownloadSingleZip}
              disabled={isDownloadingZip}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isDownloadingZip ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderArchive className="w-3.5 h-3.5" />
              )}
              دانلود پکیج این کالا
            </button>
            <button
              type="button"
              onClick={() => onRetryProduct(product.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              جستجوی مجدد
            </button>
          </div>
        </div>

        {/* WebP Image Studio Section */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                تصاویر WebP آماده انتشار
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                تصاویر واقعی استخراج‌شده از سایت برند و فروشگاه‌ها با فرمت بهینه WebP
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleFindMoreImages}
                disabled={isSearchingMore}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isSearchingMore ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="w-3.5 h-3.5" />
                )}
                جستجوی تصاویر بیشتر
              </button>

              <button
                type="button"
                onClick={() => fileUploadRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                تبدیل تصویر دستی به WebP
              </button>
              <input
                ref={fileUploadRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleManualImageUpload}
                className="hidden"
              />
            </div>
          </div>

          {product.images.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center space-y-2">
              <ImageIcon className="w-7 h-7 text-slate-400 mx-auto" />
              <p className="text-sm font-medium text-slate-700">
                تصویر قابل استخراجی به صورت خودکار از سایت‌های مبدا دریافت نشد
              </p>
              <p className="text-xs text-slate-500">
                می‌توانید دکمه «جستجوی تصاویر بیشتر» را بزنید یا لینک صفحه محصول / عکس را در کادر زیر وارد کنید.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
              {product.images.map((img, idx) => (
                <WebpImageCard
                  key={img.id}
                  img={img}
                  slug={product.slug}
                  index={idx}
                  onOpenEditor={() => setEditorIndex(idx)}
                  onToggleSelect={() => {
                    const updated = product.images.map((item) =>
                      item.id === img.id ? { ...item, selected: !item.selected } : item
                    );
                    onUpdateProduct(product.id, { images: updated });
                  }}
                  onSetPrimary={() => {
                    const updated = product.images.map((item) => ({
                      ...item,
                      isPrimary: item.id === img.id,
                      selected: item.id === img.id ? true : item.selected,
                    }));
                    onUpdateProduct(product.id, { images: updated });
                  }}
                  onRemove={() => {
                    const updated = product.images.filter((item) => item.id !== img.id);
                    if (updated.length > 0 && !updated.some((i) => i.isPrimary)) {
                      updated[0].isPrimary = true;
                    }
                    onUpdateProduct(product.id, { images: updated });
                  }}
                />
              ))}
            </div>
          )}

          {/* Custom URL image scraper */}
          <form onSubmit={handleExtractFromUrl} className="pt-2 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Link2 className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="url"
                dir="ltr"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://brand.com/product-page or direct image URL..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none text-left"
              />
            </div>
            <button
              type="submit"
              disabled={isFetchingUrl || !customUrl.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isFetchingUrl && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              استخراج و تبدیل به WebP
            </button>
          </form>

          {imageFeedback && (
            <p className="text-xs text-blue-700 font-medium">{imageFeedback}</p>
          )}
        </section>

        {/* Titles & Metadata Editor */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">نام و شناسه‌های محصول</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-700">عنوان استاندارد فارسی</label>
                <button
                  type="button"
                  onClick={() => handleCopy("titleFa", product.titleFa)}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  {copiedKey === "titleFa" ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === "titleFa" ? "کپی شد" : "کپی"}
                </button>
              </div>
              <input
                type="text"
                value={product.titleFa}
                onChange={(e) => onUpdateProduct(product.id, { titleFa: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-700">عنوان رسمی انگلیسی</label>
                <button
                  type="button"
                  onClick={() => handleCopy("titleEn", product.titleEn)}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  {copiedKey === "titleEn" ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === "titleEn" ? "کپی شد" : "کپی"}
                </button>
              </div>
              <input
                type="text"
                dir="ltr"
                value={product.titleEn}
                onChange={(e) => onUpdateProduct(product.id, { titleEn: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 text-left focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-700">برند</label>
                <input
                  type="text"
                  value={product.brand}
                  onChange={(e) => onUpdateProduct(product.id, { brand: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-700">دسته‌بندی</label>
                <input
                  type="text"
                  value={product.category}
                  onChange={(e) => onUpdateProduct(product.id, { category: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-700">کد مدل / SKU</label>
                <input
                  type="text"
                  dir="ltr"
                  value={product.modelCode}
                  onChange={(e) => onUpdateProduct(product.id, { modelCode: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono text-slate-900 text-left focus:border-blue-600 focus:bg-white focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-700">نامک (Slug)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={product.slug}
                  onChange={(e) => onUpdateProduct(product.id, { slug: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono text-slate-900 text-left focus:border-blue-600 focus:bg-white focus:outline-none"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Short & Long Descriptions */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          {/* Short Description (Option-based Editor) */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-semibold text-slate-900">
                  توضیح کوتاه (گزینه‌ای)
                </label>
                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setShortDescMode("options")}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      shortDescMode === "options"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    حالت گزینه‌ای
                  </button>
                  <button
                    type="button"
                    onClick={() => setShortDescMode("raw")}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      shortDescMode === "raw"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    متن یکجا
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const lines = product.shortDescription
                      .split(/\r?\n/)
                      .map((l) => l.trim())
                      .filter(Boolean);
                    const htmlList = `<ul>\n${lines.map((l) => `  <li>${l}</li>`).join("\n")}\n</ul>`;
                    void handleCopy("shortDescHtml", htmlList);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  {copiedKey === "shortDescHtml" ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copiedKey === "shortDescHtml" ? "کپی شد" : "کپی HTML لیست"}
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy("shortDesc", product.shortDescription)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  {copiedKey === "shortDesc" ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copiedKey === "shortDesc" ? "کپی شد" : "کپی توضیح کوتاه"}
                </button>
              </div>
            </div>

            {shortDescMode === "options" ? (
              <div className="space-y-2">
                {(() => {
                  const lines = product.shortDescription.split(/\r?\n/);
                  const safeLines = lines.length > 0 ? lines : [""];
                  return (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden bg-white">
                      {safeLines.map((line, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50/70"
                        >
                          <span className="text-xs font-mono text-slate-400 tabular-nums w-5 shrink-0">
                            {idx + 1}.
                          </span>
                          <input
                            type="text"
                            value={line}
                            placeholder="مثلاً: جلوگیری از انسداد جریان خون"
                            onChange={(e) => {
                              const next = [...safeLines];
                              next[idx] = e.target.value;
                              onUpdateProduct(product.id, {
                                shortDescription: next.join("\n"),
                              });
                            }}
                            className="flex-1 rounded border border-transparent hover:border-slate-200 focus:border-blue-600 bg-transparent focus:bg-white px-2 py-1 text-sm text-slate-900 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = safeLines.filter((_, i) => i !== idx);
                              onUpdateProduct(product.id, {
                                shortDescription: next.join("\n"),
                              });
                            }}
                            className="p-1 text-slate-400 hover:text-red-700 cursor-pointer shrink-0"
                            title="حذف گزینه"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <button
                  type="button"
                  onClick={() => {
                    const current = product.shortDescription;
                    onUpdateProduct(product.id, {
                      shortDescription: current ? `${current}\n` : "",
                    });
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  افزودن گزینه جدید
                </button>
              </div>
            ) : (
              <textarea
                rows={4}
                value={product.shortDescription}
                onChange={(e) =>
                  onUpdateProduct(product.id, { shortDescription: e.target.value })
                }
                placeholder="هر گزینه را در یک خط بنویسید..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 leading-relaxed focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            )}
          </div>

          <hr className="border-slate-100" />

          {/* Long Description */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-semibold text-slate-900">
                  توضیح بلند کامل
                </label>
                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setDescMode("structured")}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      descMode === "structured"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    متن ساده و خوانا
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescMode("html")}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      descMode === "html"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    کد HTML وردپرس
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    "longDesc",
                    descMode === "html" ? product.longDescriptionHtml : product.longDescription
                  )
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                {copiedKey === "longDesc" ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === "longDesc" ? "کپی شد" : "کپی توضیح بلند"}
              </button>
            </div>

            {descMode === "structured" ? (
              <textarea
                rows={10}
                value={product.longDescription}
                onChange={(e) => onUpdateProduct(product.id, { longDescription: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-900 leading-7 focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            ) : (
              <textarea
                rows={10}
                dir="ltr"
                value={product.longDescriptionHtml}
                onChange={(e) => onUpdateProduct(product.id, { longDescriptionHtml: e.target.value })}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs font-mono text-slate-800 leading-relaxed text-left focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            )}
          </div>
        </section>

        {/* Technical Specs & Grounded Sources */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Specs Table */}
          <section className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">جدول مشخصات فنی</h2>
              <button
                type="button"
                onClick={() =>
                  onUpdateProduct(product.id, {
                    specs: [...product.specs, { label: "", value: "" }],
                  })
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                افزودن ردیف
              </button>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
              {product.specs.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 text-center">
                  مشخصه‌ای ثبت نشده است.
                </div>
              ) : (
                product.specs.map((spec, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-3 py-2 bg-white hover:bg-slate-50/70">
                    <input
                      type="text"
                      value={spec.label}
                      placeholder="نام ویژگی"
                      onChange={(e) => {
                        const next = product.specs.map((s, i) =>
                          i === idx ? { ...s, label: e.target.value } : s
                        );
                        onUpdateProduct(product.id, { specs: next });
                      }}
                      className="w-2/5 rounded border border-transparent hover:border-slate-200 focus:border-blue-600 bg-transparent focus:bg-white px-2 py-1 text-xs font-medium text-slate-700 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={spec.value}
                      placeholder="مقدار"
                      onChange={(e) => {
                        const next = product.specs.map((s, i) =>
                          i === idx ? { ...s, value: e.target.value } : s
                        );
                        onUpdateProduct(product.id, { specs: next });
                      }}
                      className="flex-1 rounded border border-transparent hover:border-slate-200 focus:border-blue-600 bg-transparent focus:bg-white px-2 py-1 text-xs text-slate-900 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = product.specs.filter((_, i) => i !== idx);
                        onUpdateProduct(product.id, { specs: next });
                      }}
                      className="p-1 text-slate-400 hover:text-red-700 cursor-pointer"
                      title="حذف ردیف"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Grounded Web Sources */}
          <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">منابع یافت‌شده در وب</h2>
            </div>
            <p className="text-xs text-slate-500">
              سایت‌های برند و فروشگاه‌هایی که اطلاعات و عکس‌ها از آن‌ها استخراج شد:
            </p>

            {product.sources.length === 0 ? (
              <p className="text-xs text-slate-400 pt-2">لینک منبع ثبت نشده است.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {product.sources.slice(0, 8).map((src, i) => (
                  <li key={i} className="py-2.5 first:pt-1 last:pb-0">
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-start justify-between gap-2 text-xs hover:text-blue-700 transition-colors"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-medium text-slate-800 group-hover:text-blue-700 truncate">
                          {src.title}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 truncate" dir="ltr">
                          {src.domain}
                        </div>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-700 shrink-0 mt-0.5" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <ImageEditorModal
        isOpen={editorIndex !== null && product.images.length > 0}
        images={product.images}
        initialIndex={editorIndex ?? 0}
        productTitle={product.titleFa || product.query}
        settings={settings}
        onClose={() => setEditorIndex(null)}
        onReplaceImage={(oldId, updatedImg) => {
          const next = product.images.map((item) =>
            item.id === oldId ? updatedImg : item
          );
          onUpdateProduct(product.id, { images: next });
        }}
        onDeleteImage={(imgId) => {
          const next = product.images.filter((item) => item.id !== imgId);
          if (next.length > 0 && !next.some((i) => i.isPrimary)) {
            next[0] = { ...next[0], isPrimary: true };
          }
          onUpdateProduct(product.id, { images: next });
          if (next.length === 0) {
            setEditorIndex(null);
          }
        }}
        onToggleSelect={(imgId) => {
          const next = product.images.map((item) =>
            item.id === imgId ? { ...item, selected: !item.selected } : item
          );
          onUpdateProduct(product.id, { images: next });
        }}
        onSetPrimary={(imgId) => {
          const next = product.images.map((item) => ({
            ...item,
            isPrimary: item.id === imgId,
            selected: item.id === imgId ? true : item.selected,
          }));
          onUpdateProduct(product.id, { images: next });
        }}
      />
    </div>
  );
};
