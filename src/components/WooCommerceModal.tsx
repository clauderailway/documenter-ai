import React, { useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderArchive,
  KeyRound,
  Loader2,
  Send,
  ShoppingBag,
  X,
  AlertCircle,
} from "lucide-react";
import type { EnrichedProduct, EnrichmentSettings } from "../types/product.ts";
import {
  attachMissingWebpBackups,
  downloadProductsZip,
  downloadTextOnlyCsv,
  downloadWooCommerceCsv,
  type WooImageMode,
  type WooPublishStatus,
} from "../utils/exportHelpers.ts";

interface WooCommerceModalProps {
  isOpen: boolean;
  products: EnrichedProduct[];
  settings: EnrichmentSettings;
  onClose: () => void;
}

type ModalTab = "csv" | "api";

interface PushResultRow {
  productId: string;
  title: string;
  status: "pending" | "sending" | "success" | "error";
  wcId?: number;
  editUrl?: string;
  permalink?: string;
  uploadedMediaCount?: number;
  error?: string;
}

function deriveSiteOrigin(rawUrl: string): string {
  try {
    if (rawUrl && /^https?:\/\//i.test(rawUrl.trim())) {
      return new URL(rawUrl.trim()).origin;
    }
  } catch {
    // fallback below
  }
  return "https://aralhealth.com";
}

function buildCurrentMonthMediaBase(origin: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${origin.replace(/\/+$/, "")}/wp-content/uploads/${year}/${month}/`;
}

export const WooCommerceModal: React.FC<WooCommerceModalProps> = ({
  isOpen,
  products,
  settings,
  onClose,
}) => {
  const siteOrigin = useMemo(
    () => deriveSiteOrigin(settings.wpImageBaseUrl),
    [settings.wpImageBaseUrl]
  );
  const currentMonthMediaUrl = useMemo(
    () => buildCurrentMonthMediaBase(siteOrigin),
    [siteOrigin]
  );

  const [activeTab, setActiveTab] = useState<ModalTab>("csv");

  // Tab 1: CSV / ZIP state
  const [csvStatus, setCsvStatus] = useState<WooPublishStatus>("draft");
  const [csvImageMode, setCsvImageMode] = useState<WooImageMode>("wp_media");
  const [mediaBaseUrl, setMediaBaseUrl] = useState<string>(currentMonthMediaUrl);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [csvNotice, setCsvNotice] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Tab 2: Direct REST API state (keys remain strictly in memory)
  const [siteUrl, setSiteUrl] = useState<string>(() => {
    try {
      return sessionStorage.getItem("kalasaz_wc_site_url") || siteOrigin;
    } catch {
      return siteOrigin;
    }
  });
  const [apiStatus, setApiStatus] = useState<WooPublishStatus>("draft");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [wpUsername, setWpUsername] = useState<string>(() => {
    try {
      return sessionStorage.getItem("kalasaz_wc_wp_user") || "";
    } catch {
      return "";
    }
  });
  const [wpAppPassword, setWpAppPassword] = useState("");
  const [isPushing, setIsPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushRows, setPushRows] = useState<PushResultRow[]>([]);

  if (!isOpen) return null;

  const handleDownloadCsvOnly = () => {
    if (products.length === 0) return;
    setCsvError(null);
    downloadWooCommerceCsv(products, {
      publishStatus: csvStatus,
      imageMode: csvImageMode,
      wpImageBaseUrl: mediaBaseUrl,
    });
    setCsvNotice(
      `فایل kalasaz-woocommerce.csv برای ${products.length} کالا (${
        csvStatus === "draft" ? "به‌عنوان پیش‌نویس آماده ویرایش" : "به‌عنوان منتشرشده"
      }) دانلود شد.`
    );
  };

  const handleDownloadTextOnlyCsv = () => {
    if (products.length === 0) return;
    setCsvError(null);
    downloadTextOnlyCsv(products, settings.longDescFormat);
    setCsvNotice(
      `فایل kalasaz-titles-descriptions.csv (فقط عنوان، توضیح کوتاه و توضیح بلند بدون عکس و فیلد اضافی) برای ${products.length} کالا دانلود شد.`
    );
  };

  const handleDownloadWooZip = async () => {
    if (products.length === 0) return;
    setIsExportingZip(true);
    setCsvError(null);
    setCsvNotice(null);
    try {
      const exportedCount = await downloadProductsZip(
        products,
        settings.longDescFormat,
        mediaBaseUrl,
        {
          wooPublishStatus: csvStatus,
          wooImageMode: csvImageMode,
          settings,
        }
      );
      setCsvNotice(
        `پکیج ZIP شامل فایل درون‌ریزی ووکامرس (products-woocommerce.csv) و ${exportedCount} تصویر WebP در پوشه images دانلود شد.`
      );
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "خطا در آماده‌سازی پکیج ووکامرس");
    } finally {
      setIsExportingZip(false);
    }
  };

  const handleDirectPush = async (e: React.FormEvent) => {
    e.preventDefault();
    if (products.length === 0 || isPushing) return;

    const cleanUrl = siteUrl.trim().replace(/\/+$/, "");
    if (!cleanUrl || (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://"))) {
      setPushError("آدرس سایت وردپرس باید با https:// یا http:// شروع شود.");
      return;
    }
    if (!consumerKey.trim() || !consumerSecret.trim()) {
      setPushError("لطفاً Consumer Key و Consumer Secret ووکامرس را وارد کنید.");
      return;
    }

    try {
      sessionStorage.setItem("kalasaz_wc_site_url", cleanUrl);
      if (wpUsername.trim()) {
        sessionStorage.setItem("kalasaz_wc_wp_user", wpUsername.trim());
      }
    } catch {
      // ignore storage failure
    }

    setPushError(null);
    setIsPushing(true);

    const initialRows: PushResultRow[] = products.map((p) => ({
      productId: p.id,
      title: p.titleFa || p.query,
      status: "pending",
    }));
    setPushRows(initialRows);

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      setPushRows((prev) =>
        prev.map((row, idx) => (idx === i ? { ...row, status: "sending" } : row))
      );

      try {
        const [preparedProduct] = await attachMissingWebpBackups([product]);
        const res = await fetch("/api/woocommerce/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product: preparedProduct,
            siteUrl: cleanUrl,
            consumerKey: consumerKey.trim(),
            consumerSecret: consumerSecret.trim(),
            wpUsername: wpUsername.trim() || undefined,
            wpAppPassword: wpAppPassword.trim() || undefined,
            publishStatus: apiStatus,
            settings,
          }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          id?: number;
          editUrl?: string;
          permalink?: string;
          uploadedMediaCount?: number;
          error?: string;
        };

        if (!res.ok || !data.id) {
          setPushRows((prev) =>
            prev.map((row, idx) =>
              idx === i
                ? {
                    ...row,
                    status: "error",
                    error: data.error || `خطا (${res.status})`,
                  }
                : row
            )
          );
          if (res.status === 401 || res.status === 403) {
            setPushError(data.error || "احراز هویت کلید یا رمز برنامه وردپرس رد شد.");
            break;
          }
        } else {
          setPushRows((prev) =>
            prev.map((row, idx) =>
              idx === i
                ? {
                    ...row,
                    status: "success",
                    wcId: data.id,
                    editUrl: data.editUrl,
                    permalink: data.permalink,
                    uploadedMediaCount: data.uploadedMediaCount,
                  }
                : row
            )
          );
        }
      } catch (err) {
        setPushRows((prev) =>
          prev.map((row, idx) =>
            idx === i
              ? {
                  ...row,
                  status: "error",
                  error: err instanceof Error ? err.message : "خطا در برقراری ارتباط با سایت",
                }
              : row
          )
        );
      }
    }

    setIsPushing(false);
  };

  const successCount = pushRows.filter((r) => r.status === "success").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
      dir="rtl"
      onClick={() => {
        if (!isPushing) onClose();
      }}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                انتقال سریع به ووکامرس وردپرس
              </h2>
              <p className="text-xs text-slate-500 tabular-nums">
                {products.length} کالای تکمیل‌شده آماده ورود به‌صورت پیش‌نویس یا منتشرشده
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isPushing}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 disabled:opacity-40 transition-colors cursor-pointer"
            title="بستن"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="flex border-b border-slate-200 bg-white px-5 gap-4">
          <button
            type="button"
            onClick={() => setActiveTab("csv")}
            className={`py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === "csv"
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            روش اول: فایل درون‌ریزی ووکامرس (CSV / ZIP — بدون نیاز به کلید)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("api")}
            className={`py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === "api"
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            روش دوم: ارسال مستقیم به پیشخوان وردپرس (REST API)
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {activeTab === "csv" ? (
            <>
              {/* Publish Status Selector */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-800">
                  وضعیت محصولات پس از ورود به ووکامرس
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setCsvStatus("draft")}
                    className={`text-right rounded-xl border p-3 transition-colors cursor-pointer ${
                      csvStatus === "draft"
                        ? "border-blue-700 bg-blue-50/70"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <div className="text-xs font-bold text-slate-900">
                      پیش‌نویس (کد -۱) — پیشنهادی
                    </div>
                    <div className="text-[11px] text-slate-600 mt-1">
                      وارد بخش پیش‌نویس ووکامرس می‌شود تا قیمت و موجودی را وارد و سپس منتشر کنید.
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCsvStatus("publish")}
                    className={`text-right rounded-xl border p-3 transition-colors cursor-pointer ${
                      csvStatus === "publish"
                        ? "border-blue-700 bg-blue-50/70"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <div className="text-xs font-bold text-slate-900">
                      منتشر شده فوری (کد ۱)
                    </div>
                    <div className="text-[11px] text-slate-600 mt-1">
                      بلافاصله در فروشگاه نمایش داده می‌شود (در صورت نیاز بعداً ادیت بزنید).
                    </div>
                  </button>
                </div>
              </div>

              {/* Image Mode Selector */}
              <div className="space-y-2.5">
                <label className="block text-xs font-semibold text-slate-800">
                  نحوه اتصال تصاویر محصول در فایل CSV
                </label>
                <div className="space-y-2">
                  <label
                    className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition-colors ${
                      csvImageMode === "wp_media"
                        ? "border-blue-700 bg-blue-50/50"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="wooImageMode"
                      checked={csvImageMode === "wp_media"}
                      onChange={() => setCsvImageMode("wp_media")}
                      className="mt-1 accent-blue-700"
                    />
                    <div className="flex-1 space-y-2">
                      <div className="text-xs font-semibold text-slate-900">
                        آدرس پوشه رسانه وردپرس (برای عکس‌های WebP بهینه‌شده و ادیت‌شده داخل ZIP)
                      </div>
                      {csvImageMode === "wp_media" && (
                        <div className="space-y-1.5">
                          <input
                            type="url"
                            value={mediaBaseUrl}
                            onChange={(e) => setMediaBaseUrl(e.target.value)}
                            dir="ltr"
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                          />
                          <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            <button
                              type="button"
                              onClick={() => setMediaBaseUrl(currentMonthMediaUrl)}
                              className="text-blue-700 hover:underline font-medium cursor-pointer"
                            >
                              مسیر رسانه ماه جاری
                            </button>
                            <span className="text-slate-300">·</span>
                            <button
                              type="button"
                              onClick={() => setMediaBaseUrl(settings.wpImageBaseUrl)}
                              className="text-slate-600 hover:underline font-medium cursor-pointer"
                            >
                              مسیر تنظیمات هاست
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition-colors ${
                      csvImageMode === "source_url"
                        ? "border-blue-700 bg-blue-50/50"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="wooImageMode"
                      checked={csvImageMode === "source_url"}
                      onChange={() => setCsvImageMode("source_url")}
                      className="mt-1 accent-blue-700"
                    />
                    <div>
                      <div className="text-xs font-semibold text-slate-900">
                        لینک مستقیم عکس مبدا (دانلود خودکار توسط ووکامرس هنگام درون‌ریزی)
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        بدون نیاز به آپلود دستی عکس در رسانه؛ توجه کنید تغییرات برش یا حذف لوگو در سرور خودتان نیاز به آپلود پوشه WebP یا روش API دارد.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={handleDownloadTextOnlyCsv}
                  disabled={products.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-slate-600" />
                  دانلود CSV متنی (فقط عنوان و توضیحات)
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCsvOnly}
                  disabled={products.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
                  دانلود فایل CSV ووکامرس
                </button>
                <button
                  type="button"
                  onClick={handleDownloadWooZip}
                  disabled={products.length === 0 || isExportingZip}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isExportingZip ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FolderArchive className="w-4 h-4" />
                  )}
                  دانلود پکیج کامل ZIP (CSV ووکامرس + پوشه عکس‌های WebP)
                </button>
              </div>

              {csvNotice && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800">
                  {csvNotice}
                </div>
              )}
              {csvError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
                  {csvError}
                </div>
              )}

              {/* 3-Step WP Guide */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                <div className="text-xs font-bold text-slate-800">
                  راهنمای ۳ مرحله‌ای ورود به پیشخوان وردپرس:
                </div>
                <ol className="text-xs text-slate-600 space-y-1.5 list-decimal pr-4">
                  <li>
                    در صورت انتخاب «پوشه رسانه وردپرس»، فایل‌های داخل پوشه <span className="font-mono text-slate-800" dir="ltr">images/</span> را در بخش <strong>رسانه ← افزودن</strong> وردپرس رها کنید.
                  </li>
                  <li>
                    وارد مسیر <strong>محصولات ← همه محصولات ← درون‌ریزی (Import)</strong> در پیشخوان وردپرس شوید.
                  </li>
                  <li>
                    فایل <span className="font-mono text-slate-800" dir="ltr">kalasaz-woocommerce.csv</span> (یا <span className="font-mono text-slate-800" dir="ltr">products-woocommerce.csv</span> داخل ZIP) را انتخاب و دکمه <strong>ادامه ← اجرای درون‌ریزی</strong> را بزنید؛ ستون‌های نام، لیست ویژگی‌ها، توضیح بلند HTML، دسته‌بندی و عکس خودکار نگاشت می‌شوند.
                  </li>
                </ol>
              </div>
            </>
          ) : (
            <form onSubmit={handleDirectPush} className="space-y-4">
              <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 text-xs text-blue-900 space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" />
                  مسیر ساخت کلیدهای دسترسی در پیشخوان وردپرس:
                </div>
                <p>
                  ۱. کلید ووکامرس: <strong>ووکامرس ← پیکربندی ← پیشرفته ← REST API ← افزودن کلید</strong> (سطح دسترسی: <strong>خواندن/نوشتن</strong>).
                </p>
                <p>
                  ۲. برای آپلود خودکار عکس‌های WebP ویرایش‌شده داخل رسانه سایت: <strong>کاربران ← شناسنامه ← رمزهای برنامه (Application Passwords)</strong>.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    آدرس سایت وردپرس
                  </label>
                  <input
                    type="url"
                    value={siteUrl}
                    onChange={(e) => setSiteUrl(e.target.value)}
                    placeholder="https://aralhealth.com"
                    dir="ltr"
                    required
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    وضعیت ثبت
                  </label>
                  <select
                    value={apiStatus}
                    onChange={(e) => setApiStatus(e.target.value as WooPublishStatus)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    <option value="draft">پیش‌نویس (آماده ویرایش)</option>
                    <option value="publish">منتشر شده فوری</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    WooCommerce Consumer Key
                  </label>
                  <input
                    type="text"
                    value={consumerKey}
                    onChange={(e) => setConsumerKey(e.target.value)}
                    placeholder="ck_..."
                    dir="ltr"
                    required
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    WooCommerce Consumer Secret
                  </label>
                  <input
                    type="password"
                    value={consumerSecret}
                    onChange={(e) => setConsumerSecret(e.target.value)}
                    placeholder="cs_..."
                    dir="ltr"
                    required
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    نام کاربری وردپرس (اختیاری — برای آپلود WebP)
                  </label>
                  <input
                    type="text"
                    value={wpUsername}
                    onChange={(e) => setWpUsername(e.target.value)}
                    placeholder="admin"
                    dir="ltr"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">
                    Application Password وردپرس (اختیاری)
                  </label>
                  <input
                    type="password"
                    value={wpAppPassword}
                    onChange={(e) => setWpAppPassword(e.target.value)}
                    placeholder="xxxx xxxx xxxx xxxx"
                    dir="ltr"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-500">
                کلیدهای امنیتی فقط در حافظه موقت همین پنجره نگهداری و مستقیم برای ثبت کالا ارسال می‌شوند و هیچ‌جا ذخیره نمی‌گردند.
              </p>

              {pushError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{pushError}</span>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <button
                  type="submit"
                  disabled={products.length === 0 || isPushing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer tabular-nums"
                >
                  {isPushing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  {isPushing
                    ? "در حال ارسال به ووکامرس..."
                    : `ارسال مستقیم (${products.length} کالا)`}
                </button>

                {pushRows.length > 0 && (
                  <span className="text-xs text-slate-600 tabular-nums">
                    {successCount} از {pushRows.length} کالا در سایت ثبت شد
                  </span>
                )}
              </div>

              {pushRows.length > 0 && (
                <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                  {pushRows.map((row) => (
                    <div
                      key={row.productId}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs bg-white"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-900 truncate">
                          {row.title}
                        </div>
                        {row.error && (
                          <div className="text-[11px] text-red-700 truncate mt-0.5">
                            {row.error}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {row.status === "pending" && (
                          <span className="text-slate-400">در انتظار</span>
                        )}
                        {row.status === "sending" && (
                          <span className="inline-flex items-center gap-1 text-blue-700">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            در حال ارسال
                          </span>
                        )}
                        {row.status === "error" && (
                          <span className="text-red-700 font-medium">خطا</span>
                        )}
                        {row.status === "success" && (
                          <>
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium tabular-nums">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              ثبت شد (#{row.wcId})
                            </span>
                            {row.editUrl && (
                              <a
                                href={row.editUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 whitespace-nowrap"
                              >
                                ویرایش در وردپرس
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
