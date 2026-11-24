import React, { useState } from "react";
import { Check, Cpu, KeyRound, Plus, Trash2, Zap } from "lucide-react";
import type {
  ContentTone,
  CustomProviderProfile,
  DomainProfile,
  EnrichmentSettings,
  LongDescFormat,
  OutputLanguage,
  WebpFitMode,
} from "../types/product.ts";
import { DEFAULT_SETTINGS } from "../types/product.ts";

interface SettingsPanelProps {
  settings: EnrichmentSettings;
  onChange: (next: EnrichmentSettings) => void;
}

type ExternalProviderType = CustomProviderProfile["type"];

const PROVIDER_PRESETS: Record<
  ExternalProviderType,
  { label: string; baseUrl: string; defaultModel: string; envVar: string }
> = {
  openrouter: {
    label: "OpenRouter (مدل‌های رایگان)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    envVar: "OPENROUTER_API_KEY",
  },
  groq: {
    label: "Groq (رایگان)",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    envVar: "GROQ_API_KEY",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    envVar: "OPENAI_API_KEY",
  },
  custom: {
    label: "سفارشی (سازگار با OpenAI مثل DeepSeek / AvalAI / Together)",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    envVar: "CUSTOM_AI_API_KEY",
  },
  pollinations: {
    label: "Pollinations (بدون کلید API)",
    baseUrl: "https://text.pollinations.ai/openai",
    defaultModel: "openai-fast",
    envVar: "—",
  },
};

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onChange }) => {
  const [providerType, setProviderType] = useState<ExternalProviderType>("openrouter");
  const [providerName, setProviderName] = useState("OpenRouter اصلی");
  const [providerBaseUrl, setProviderBaseUrl] = useState(PROVIDER_PRESETS.openrouter.baseUrl);
  const [providerModel, setProviderModel] = useState(PROVIDER_PRESETS.openrouter.defaultModel);
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerFormError, setProviderFormError] = useState<string | null>(null);

  const customProviders = settings.customProviders ?? [];
  const activeProviderId = settings.aiProviderId || "gemini-default";
  const isKeylessType = providerType === "pollinations";

  const handleProviderTypeChange = (nextType: ExternalProviderType) => {
    setProviderType(nextType);
    const preset = PROVIDER_PRESETS[nextType];
    setProviderBaseUrl(preset.baseUrl);
    setProviderModel(preset.defaultModel);
    if (!providerName.trim() || Object.values(PROVIDER_PRESETS).some((p) => providerName.startsWith(p.label.split(" ")[0]))) {
      setProviderName(
        nextType === "custom" ? "پروایدر سفارشی" : `${preset.label.split(" ")[0]} اصلی`
      );
    }
    setProviderFormError(null);
  };

  const handleAddProvider = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = providerName.trim();
    const cleanBaseUrl = providerBaseUrl.trim().replace(/\/+$/, "");
    const cleanModel = providerModel.trim();

    if (!cleanName) {
      setProviderFormError("لطفاً یک نام برای ارائه‌دهنده وارد کنید.");
      return;
    }
    if (!cleanBaseUrl.startsWith("https://")) {
      setProviderFormError("آدرس Base URL باید با https:// شروع شود.");
      return;
    }
    if (!cleanModel) {
      setProviderFormError("لطفاً نام مدل را وارد کنید.");
      return;
    }

    const newProfile: CustomProviderProfile = {
      id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      type: providerType,
      baseUrl: cleanBaseUrl,
      model: cleanModel,
      apiKey: providerApiKey.trim() || undefined,
    };

    onChange({
      ...settings,
      aiProviderId: newProfile.id,
      customProviders: [...customProviders, newProfile],
    });
    setProviderApiKey("");
    setProviderFormError(null);
  };

  const handleRemoveProvider = (id: string) => {
    const nextList = customProviders.filter((p) => p.id !== id);
    onChange({
      ...settings,
      aiProviderId: activeProviderId === id ? "gemini-default" : activeProviderId,
      customProviders: nextList,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-slate-900">تنظیمات پروایدرها، فروشگاه و تبدیل WebP</h1>
            <p className="text-xs text-slate-500">
              مدیریت ارائه‌دهندگان هوش مصنوعی و تنظیمات پیش‌فرض برای سایت تجهیزات پزشکی و ووکامرس.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_SETTINGS)}
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            بازگشت به پیش‌فرض
          </button>
        </div>

        {/* AI Providers Section */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-700" />
                ارائه‌دهندگان هوش مصنوعی (AI Providers)
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                همه سرویس‌ها با سهمیه رایگان کار می‌کنند: Gemini رایگان به‌صورت پیش‌فرض فعال است و در صورت شلوغی یا اتمام سهمیه، خودکار به مدل رایگان بعدی و سپس OpenRouter / Groq / Pollinations سوییچ می‌شود.
              </p>
            </div>
          </div>

          {/* Saved Providers List */}
          <div className="space-y-2">
            {/* Built-in Gemini Default with Custom API Key Input */}
            <div
              className={`rounded-lg border p-4 space-y-3 transition-colors ${
                activeProviderId === "gemini-default"
                  ? "border-blue-600 bg-blue-50/50"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <div
                onClick={() => onChange({ ...settings, aiProviderId: "gemini-default" })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange({ ...settings, aiProviderId: "gemini-default" });
                  }
                }}
                className="flex items-center justify-between gap-3 cursor-pointer"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                      activeProviderId === "gemini-default"
                        ? "bg-blue-700 border-blue-700 text-white"
                        : "border-slate-300 bg-white"
                    }`}
                  >
                    {activeProviderId === "gemini-default" && <Check className="w-3 h-3" />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      موتور پیش‌فرض (Gemini رایگان + جابه‌جایی خودکار مدل‌ها)
                    </div>
                    <div className="text-xs text-slate-500 font-mono truncate" dir="ltr">
                      gemini-3.8-flash · 3.6-flash · 3.5-flash-lite · gemma-4
                    </div>
                  </div>
                </div>
                {activeProviderId === "gemini-default" && (
                  <span className="text-xs font-medium text-blue-700 whitespace-nowrap shrink-0">
                    فعال
                  </span>
                )}
              </div>

              {/* API Key Input Section */}
              <div className="pt-2 border-t border-slate-200/80 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                <label className="block text-xs font-medium text-slate-700">
                  کلید اختصاصی AI Studio (Gemini API Key)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    dir="ltr"
                    value={settings.geminiApiKey || ""}
                    onChange={(e) => onChange({ ...settings, geminiApiKey: e.target.value })}
                    placeholder="AIzaSy..."
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                  />
                  {settings.geminiApiKey ? (
                    <span className="text-[11px] font-medium text-emerald-600 whitespace-nowrap">
                      کلید فعال شد ✓
                    </span>
                  ) : (
                    <span className="text-[11px] text-slate-400 whitespace-nowrap">
                      پیش‌فرض سرور
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  کلید رایگان از aistudio.google.com/apikey بگیرید. با وارد کردن کلید، درخواست‌ها با سهمیه حساب شما پردازش می‌شوند؛ خالی بگذارید تا از کلید سرور استفاده شود.
                </p>
              </div>
            </div>

            {/* Auto free fallback + extra free providers */}
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-emerald-600" />
                    جابه‌جایی خودکار بین مدل‌های رایگان
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    وقتی یک مدل شلوغ یا سهمیه‌اش تمام شود، سیستم خودکار مدل بعدی و سپس ارائه‌دهنده رایگان بعدی را امتحان می‌کند تا کار همیشه ادامه پیدا کند.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoFreeFallback !== false}
                  onClick={() =>
                    onChange({ ...settings, autoFreeFallback: settings.autoFreeFallback === false })
                  }
                  className={`relative w-11 h-6 rounded-full transition-colors shrink-0 cursor-pointer ${
                    settings.autoFreeFallback !== false ? "bg-emerald-600" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
                      settings.autoFreeFallback !== false ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <label className="text-[11px] font-medium text-slate-700">
                    کلید رایگان OpenRouter (اختیاری)
                  </label>
                </div>
                <input
                  type="password"
                  dir="ltr"
                  value={settings.openrouterApiKey || ""}
                  onChange={(e) => onChange({ ...settings, openrouterApiKey: e.target.value })}
                  placeholder="sk-or-v1-..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-emerald-600 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  از openrouter.ai/keys بگیرید (رایگان، بدون کارت). مدل‌های <code className="font-mono">:free</code> مثل Gemma 4 و Nemotron به‌صورت خودکار استفاده می‌شوند.
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <KeyRound className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <label className="text-[11px] font-medium text-slate-700">
                    کلید رایگان Groq (اختیاری)
                  </label>
                </div>
                <input
                  type="password"
                  dir="ltr"
                  value={settings.groqApiKey || ""}
                  onChange={(e) => onChange({ ...settings, groqApiKey: e.target.value })}
                  placeholder="gsk_..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-emerald-600 focus:outline-none"
                />
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  از console.groq.com/keys بگیرید. مدل‌های Llama و GPT-OSS با سرعت بالا و سهمیه رایگان.
                </p>

                <p className="text-[11px] text-slate-500 leading-relaxed pt-1">
                  حتی بدون هیچ کلیدی، آخرین لایه پشتیبان (Pollinations) کار می‌کند؛ اما نسخه بدون کلید آن محدود به یک پاسخ در هر ۴۵ ثانیه است و برای پردازش گروهی، کلید Gemini یا OpenRouter/Groq توصیه می‌شود.
                </p>
              </div>
            </div>

            {/* User-Added Custom Providers */}
            {customProviders.map((prov) => {
              const isSelected = activeProviderId === prov.id;
              const envHint = PROVIDER_PRESETS[prov.type]?.envVar ?? "CUSTOM_AI_API_KEY";
              const keyless = prov.type === "pollinations";
              const hasKey = Boolean(prov.apiKey) || keyless;
              return (
                <div
                  key={prov.id}
                  onClick={() => onChange({ ...settings, aiProviderId: prov.id })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChange({ ...settings, aiProviderId: prov.id });
                    }
                  }}
                  className={`rounded-lg border p-3.5 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                    isSelected
                      ? "border-blue-600 bg-blue-50/50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? "bg-blue-700 border-blue-700 text-white"
                          : "border-slate-300 bg-white"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3" />}
                    </span>
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {prov.name}
                      </div>
                      <div className="text-xs text-slate-500 font-mono truncate" dir="ltr">
                        {prov.model} · {prov.baseUrl}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {keyless ? (
                          "بدون نیاز به کلید API"
                        ) : hasKey ? (
                          <span className="text-emerald-600">کلید ذخیره شده ✓</span>
                        ) : (
                          <>
                            بدون کلید — از متغیر سرور{" "}
                            <code className="font-mono text-slate-600">{envHint}</code> استفاده می‌شود
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isSelected && (
                      <span className="text-xs font-medium text-blue-700 whitespace-nowrap">
                        فعال
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveProvider(prov.id);
                      }}
                      title="حذف ارائه‌دهنده"
                      className="p-1.5 rounded-md text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add New Provider Form */}
          <form
            onSubmit={handleAddProvider}
            className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-4"
          >
            <div className="text-xs font-semibold text-slate-800">
              افزودن ارائه‌دهنده جدید
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">نوع سرویس</label>
                <select
                  value={providerType}
                  onChange={(e) => handleProviderTypeChange(e.target.value as ExternalProviderType)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  {(Object.keys(PROVIDER_PRESETS) as ExternalProviderType[]).map((key) => (
                    <option key={key} value={key}>
                      {PROVIDER_PRESETS[key].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">نام نمایشی پروفایل</label>
                <input
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder="مثلاً OpenRouter اصلی"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  آدرس پایه (Base URL)
                </label>
                <input
                  type="url"
                  dir="ltr"
                  value={providerBaseUrl}
                  onChange={(e) => setProviderBaseUrl(e.target.value)}
                  placeholder="https://openrouter.ai/api/v1"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">نام مدل (Model ID)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={providerModel}
                  onChange={(e) => setProviderModel(e.target.value)}
                  placeholder="google/gemma-4-31b-it:free"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  کلید API{isKeylessType ? " (برای این سرویس لازم نیست)" : " (اختیاری اگر روی سرور تنظیم شده)"}
                </label>
                <input
                  type="password"
                  dir="ltr"
                  disabled={isKeylessType}
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  placeholder={isKeylessType ? "بدون کلید" : "sk-..."}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
                />
              </div>
            </div>

            {providerFormError && (
              <p className="text-xs text-red-700">{providerFormError}</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-500 leading-relaxed max-w-lg">
                کلید واردشده همراه تنظیمات ذخیره می‌شود و فقط در درخواست‌های سمت سرور استفاده می‌شود. اگر خالی بگذارید، از متغیر محیطی{" "}
                <code className="font-mono text-slate-700">
                  {PROVIDER_PRESETS[providerType].envVar}
                </code>{" "}
                روی سرور خوانده می‌شود.
              </p>

              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                افزودن و فعال‌سازی
              </button>
            </div>
          </form>
        </section>

        {/* Store & Medical Domain Profile */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          <h2 className="text-base font-semibold text-slate-900">پروفایل فروشگاه و حوزه محصولات</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">حوزه تخصصی کالاها</label>
              <select
                value={settings.domainProfile}
                onChange={(e) =>
                  onChange({ ...settings, domainProfile: e.target.value as DomainProfile })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value="medical">تجهیزات پزشکی و سلامت (مناسب آرال هلث)</option>
                <option value="general">عمومی (سایر دسته‌بندی‌های فروشگاهی)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">نام فروشگاه مقصد</label>
              <input
                type="text"
                value={settings.storeName}
                onChange={(e) => onChange({ ...settings, storeName: e.target.value })}
                placeholder="آرال هلث (تجهیزات پزشکی)"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="md:col-span-2 space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                پیشوند آدرس تصاویر در فایل CSV ووکامرس (Media Upload URL)
              </label>
              <input
                type="url"
                dir="ltr"
                value={settings.wpImageBaseUrl}
                onChange={(e) => onChange({ ...settings, wpImageBaseUrl: e.target.value })}
                placeholder="https://aralhealth.com/wp-content/uploads/products/"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:bg-white focus:outline-none"
              />
              <p className="text-[11px] text-slate-500">
                پس از آپلود عکس‌های WebP پوشه images داخل هاست وردپرس، ووکامرس از این مسیر به صورت خودکار تمام تصاویر هر کالا را به آن متصل می‌کند.
              </p>
            </div>
          </div>
        </section>

        {/* Text & SEO Settings */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          <h2 className="text-base font-semibold text-slate-900">تنظیمات متن و توضیحات کالا</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">زبان خروجی</label>
              <select
                value={settings.outputLanguage}
                onChange={(e) =>
                  onChange({ ...settings, outputLanguage: e.target.value as OutputLanguage })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value="fa">فارسی کامل (پیشنهادی برای فروشگاه ایرانی)</option>
                <option value="fa_en">فارسی + اصطلاحات تخصصی انگلیسی</option>
                <option value="en">انگلیسی کامل (برای فروشگاه‌های بین‌المللی)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">لحن نگارش توضیحات</label>
              <select
                value={settings.tone}
                onChange={(e) =>
                  onChange({ ...settings, tone: e.target.value as ContentTone })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value="commercial">فروشگاهی، تخصصی و اعتمادبخش</option>
                <option value="technical">فنی و بالینی (تمرکز بر مشخصات و دقت)</option>
                <option value="minimal">کوتاه، رسمی و مینیمال</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                فرمت پیش‌فرض توضیح بلند در خروجی CSV
              </label>
              <select
                value={settings.longDescFormat}
                onChange={(e) =>
                  onChange({ ...settings, longDescFormat: e.target.value as LongDescFormat })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value="html">کد HTML استاندارد (آماده وردپرس و ووکامرس)</option>
                <option value="structured">متن ساختاریافته ساده</option>
              </select>
            </div>
          </div>
        </section>

        {/* WebP Conversion Settings */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          <h2 className="text-base font-semibold text-slate-900">تنظیمات بهینه‌سازی و تبدیل WebP</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                حداکثر ابعاد تصویر WebP (پیکسل)
              </label>
              <select
                value={settings.webpMaxWidth}
                onChange={(e) =>
                  onChange({ ...settings, webpMaxWidth: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value={800}>800 × 800 px</option>
                <option value={1000}>1000 × 1000 px</option>
                <option value={1200}>1200 × 1200 px</option>
                <option value={1600}>1600 × 1600 px</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">کیفیت فشرده‌سازی WebP</label>
              <select
                value={settings.webpQuality}
                onChange={(e) =>
                  onChange({ ...settings, webpQuality: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value={75}>75% (حجم بسیار کم)</option>
                <option value={85}>85% (تعادل بهینه کیفیت و حجم)</option>
                <option value={92}>92% (کیفیت حداکثری)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">کادربندی تصویر خروجی</label>
              <select
                value={settings.webpFitMode}
                onChange={(e) =>
                  onChange({ ...settings, webpFitMode: e.target.value as WebpFitMode })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value="contain_white">کادر مربع ۱:۱ با پس‌زمینه سفید یکدست (استاندارد ووکامرس)</option>
                <option value="inside">حفظ نسبت تصویر اصلی (بدون کادر سفید)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                تعداد تصاویر هدف برای هر کالا
              </label>
              <select
                value={settings.targetImageCount}
                onChange={(e) =>
                  onChange({ ...settings, targetImageCount: Number(e.target.value) })
                }
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
              >
                <option value={3}>3 تصویر WebP</option>
                <option value={5}>5 تصویر WebP</option>
                <option value={8}>8 تصویر WebP</option>
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
