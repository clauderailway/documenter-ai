import React, { useState } from "react";
import { Check, Cpu, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Zap } from "lucide-react";
import type {
  ContentTone,
  CustomProviderProfile,
  DomainProfile,
  EnrichmentSettings,
  GeminiModelMode,
  LongDescFormat,
  OutputLanguage,
  WebpFitMode,
} from "../types/product.ts";
import { DEFAULT_SETTINGS } from "../types/product.ts";

interface SettingsPanelProps {
  settings: EnrichmentSettings;
  onChange: (next: EnrichmentSettings) => void;
}

interface KeyTestResult {
  maskedKey: string;
  isServerDefault: boolean;
  ok: boolean;
  workingModel?: string;
  error?: string;
}

type ExternalProviderType = CustomProviderProfile["type"];

const PROVIDER_PRESETS: Record<
  ExternalProviderType,
  { label: string; baseUrl: string; defaultModel: string; envVar: string }
> = {
  openrouter: {
    label: "OpenRouter (دارای مدل‌های رایگان :free)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    envVar: "OPENROUTER_API_KEY",
  },
  groq: {
    label: "Groq (رایگان و فوق‌سریع)",
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

function parseKeyList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw || "").split(/[\r\n,;\s]+/)) {
    const clean = part.trim();
    if (clean.length >= 10 && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function maskKeyDisplay(key: string): string {
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onChange }) => {
  const [newGeminiKeyInput, setNewGeminiKeyInput] = useState("");
  const [isTestingKeys, setIsTestingKeys] = useState(false);
  const [keyTestResults, setKeyTestResults] = useState<KeyTestResult[] | null>(null);
  const [keyTestError, setKeyTestError] = useState<string | null>(null);

  const [providerType, setProviderType] = useState<ExternalProviderType>("openrouter");
  const [providerName, setProviderName] = useState("OpenRouter رایگان");
  const [providerBaseUrl, setProviderBaseUrl] = useState(PROVIDER_PRESETS.openrouter.baseUrl);
  const [providerModel, setProviderModel] = useState(PROVIDER_PRESETS.openrouter.defaultModel);
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerFormError, setProviderFormError] = useState<string | null>(null);

  const customProviders = settings.customProviders ?? [];
  const activeProviderId = settings.aiProviderId || "gemini-default";
  const savedGeminiKeys = parseKeyList(settings.geminiApiKey || "");
  const geminiModelMode: GeminiModelMode = settings.geminiModelMode || "auto_free";
  const freeTierSaver = settings.freeTierSaver !== false;
  const isKeylessType = providerType === "pollinations";
  const autoFreeFallback = settings.autoFreeFallback !== false;

  const handleAddGeminiKeys = () => {
    const incoming = parseKeyList(newGeminiKeyInput);
    if (incoming.length === 0) return;
    const merged = Array.from(new Set([...savedGeminiKeys, ...incoming])).slice(0, 20);
    onChange({
      ...settings,
      aiProviderId: "gemini-default",
      geminiApiKey: merged.join("\n"),
    });
    setNewGeminiKeyInput("");
    setKeyTestResults(null);
    setKeyTestError(null);
  };

  const handleRemoveGeminiKey = (keyToRemove: string) => {
    const next = savedGeminiKeys.filter((k) => k !== keyToRemove);
    onChange({
      ...settings,
      geminiApiKey: next.join("\n"),
    });
    setKeyTestResults(null);
  };

  const handleTestKeys = async () => {
    setIsTestingKeys(true);
    setKeyTestError(null);
    setKeyTestResults(null);

    // Include any unsaved key typed in the input box automatically
    const pendingIncoming = parseKeyList(newGeminiKeyInput);
    let effectiveSettings = settings;
    if (pendingIncoming.length > 0) {
      const merged = Array.from(new Set([...savedGeminiKeys, ...pendingIncoming])).slice(0, 20);
      effectiveSettings = {
        ...settings,
        aiProviderId: "gemini-default",
        geminiApiKey: merged.join("\n"),
      };
      onChange(effectiveSettings);
      setNewGeminiKeyInput("");
    }

    try {
      const res = await fetch("/api/ai/test-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: effectiveSettings }),
      });
      const rawText = await res.text();
      let data: { results?: KeyTestResult[]; error?: string } | null = null;
      try {
        data = JSON.parse(rawText) as { results?: KeyTestResult[]; error?: string };
      } catch {
        data = null;
      }
      if (!data || !res.ok) {
        throw new Error(data?.error || `خطا در تست کلیدها (کد ${res.status})`);
      }
      setKeyTestResults(data.results || []);
    } catch (err) {
      setKeyTestError(err instanceof Error ? err.message : "خطا در بررسی کلیدها");
    } finally {
      setIsTestingKeys(false);
    }
  };

  const handleProviderTypeChange = (nextType: ExternalProviderType) => {
    setProviderType(nextType);
    const preset = PROVIDER_PRESETS[nextType];
    setProviderBaseUrl(preset.baseUrl);
    setProviderModel(preset.defaultModel);
    if (
      !providerName.trim() ||
      Object.values(PROVIDER_PRESETS).some((p) => providerName.startsWith(p.label.split(" ")[0]))
    ) {
      setProviderName(
        nextType === "custom"
          ? "پروایدر سفارشی"
          : nextType === "openrouter" || nextType === "groq"
            ? `${preset.label.split(" ")[0]} رایگان`
            : `${preset.label.split(" ")[0]} اصلی`
      );
    }
    setProviderFormError(null);
  };

  const handleAddProvider = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = providerName.trim();
    const cleanBaseUrl = providerBaseUrl.trim().replace(/\/+$/, "");
    const cleanModel = providerModel.trim();
    const cleanApiKey = providerApiKey.trim();

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
      ...(cleanApiKey ? { apiKey: cleanApiKey } : {}),
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
              مدیریت کلیدهای رایگان AI Studio، چرخش خودکار کلیدها و تنظیمات پیش‌فرض فروشگاه.
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
                ارائه‌دهندگان هوش مصنوعی و کلیدهای رایگان
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                می‌توانید یک یا چند کلید رایگان Google AI Studio اضافه کنید تا سیستم به‌صورت خودکار بین مدل‌های رایگان و کلیدها جابه‌جا شود و به محدودیت سهمیه نخورید.
              </p>
            </div>
          </div>

          {/* Saved Providers List */}
          <div className="space-y-2.5">
            {/* Built-in Gemini Default with Free-Tier Multi-Key Pool */}
            <div
              className={`rounded-lg border p-4 space-y-4 transition-colors ${
                activeProviderId === "gemini-default"
                  ? "border-blue-600 bg-blue-50/40"
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
                      Google AI Studio (Gemini رایگان با چرخش خودکار مدل و کلید)
                    </div>
                    <div className="text-xs text-slate-500 font-mono truncate" dir="ltr">
                      Auto-discovery: Gemini 4 / 3.x Flash &amp; Flash-Lite · Gemma 4
                    </div>
                  </div>
                </div>
                {activeProviderId === "gemini-default" && (
                  <span className="text-xs font-medium text-blue-700 whitespace-nowrap shrink-0">
                    فعال
                  </span>
                )}
              </div>

              {/* Multi-Key Pool Manager */}
              <div
                className="pt-3 border-t border-slate-200/80 space-y-3"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <label className="text-xs font-medium text-slate-800 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-blue-700" />
                    کلیدهای رایگان AI Studio ({savedGeminiKeys.length > 0 ? `${savedGeminiKeys.length} کلید فعال` : "کلید پیش‌فرض سرور"})
                  </label>
                  <button
                    type="button"
                    onClick={handleTestKeys}
                    disabled={isTestingKeys}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {isTestingKeys ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3" />
                    )}
                    تست اتصال کلیدها
                  </button>
                </div>

                {/* Add One or Multiple Keys */}
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    dir="ltr"
                    value={newGeminiKeyInput}
                    onChange={(e) => setNewGeminiKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddGeminiKeys();
                      }
                    }}
                    placeholder="AIzaSy... (می‌توانید چند کلید را با ویرگول یا جداگانه اضافه کنید)"
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddGeminiKeys}
                    disabled={parseKeyList(newGeminiKeyInput).length === 0}
                    className="inline-flex items-center gap-1 rounded-lg bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    افزودن کلید
                  </button>
                </div>

                {/* Saved Keys List */}
                {savedGeminiKeys.length > 0 && (
                  <div className="space-y-1.5">
                    {savedGeminiKeys.map((k, idx) => (
                      <div
                        key={k}
                        className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[11px] font-medium text-slate-500 shrink-0">
                            کلید {idx + 1}
                          </span>
                          <code className="text-xs font-mono text-slate-800 truncate" dir="ltr">
                            {maskKeyDisplay(k)}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveGeminiKey(k)}
                          title="حذف کلید"
                          className="p-1 rounded text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Key Test Results */}
                {keyTestError && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {keyTestError}
                  </div>
                )}

                {keyTestResults && (
                  <div className="space-y-1.5 rounded-md border border-slate-200 bg-white p-2.5">
                    {keyTestResults.map((res, idx) => (
                      <div
                        key={`${res.maskedKey}-${idx}`}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-mono text-slate-700" dir="ltr">
                          {res.maskedKey}
                        </span>
                        {res.ok ? (
                          <span className="text-emerald-700 font-medium">
                            متصل ✓ ({res.workingModel})
                          </span>
                        ) : (
                          <span className="text-red-700">{res.error}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Model Strategy & Free-Tier Quota Saver */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-700">
                      اولویت انتخاب مدل Gemini
                    </label>
                    <select
                      value={geminiModelMode}
                      onChange={(e) =>
                        onChange({
                          ...settings,
                          geminiModelMode: e.target.value as GeminiModelMode,
                        })
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                    >
                      <option value="auto_free">خودکار — کشف و انتخاب بهترین مدل رایگان فعال (پیشنهادی)</option>
                      <option value="gemini-flash-lite-latest">gemini-flash-lite-latest (بیشترین سهمیه رایگان)</option>
                      <option value="gemini-flash-latest">gemini-flash-latest (دقیق و متعادل)</option>
                      <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (سبک و سریع)</option>
                      <option value="gemini-4-hydrogen">gemini-4-hydrogen (جدیدترین نسل)</option>
                      <option value="auto_quality">خودکار — حداکثر کیفیت</option>
                    </select>
                  </div>

                  <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={freeTierSaver}
                      onChange={(e) =>
                        onChange({ ...settings, freeTierSaver: e.target.checked })
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                    />
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-slate-800 flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        صرفه‌جویی در سهمیه رایگان
                      </div>
                      <p className="text-[11px] text-slate-500 leading-snug">
                        کاهش مصرف به ۱ درخواست در هر کالا و جلوگیری از محدودیت جستجوی گوگل در نسخه رایگان.
                      </p>
                    </div>
                  </label>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  نکته: اگر ۲ یا چند کلید رایگان از اکانت‌های مختلف AI Studio اضافه کنید، درخواست‌ها بین آن‌ها تقسیم می‌شوند و در صورت پرشدن سهمیه یک کلید، سیستم خودکار روی کلید یا مدل رایگان بعدی ادامه می‌دهد.
                </p>
              </div>
            </div>

            {/* Cross-provider free fallback */}
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <Zap className="w-4 h-4 text-emerald-600" />
                    پشتیبان رایگان بین سرویس‌ها
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    وقتی همه کلیدها و مدل‌های Gemini تمام یا شلوغ شوند، سیستم خودکار به مدل‌های رایگان OpenRouter و سپس Groq و در نهایت سرویس بدون کلید Pollinations سوییچ می‌کند تا کار متوقف نشود.
                  </p>
                </div>
                <label className="flex items-center gap-2 shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoFreeFallback}
                    onChange={(e) =>
                      onChange({ ...settings, autoFreeFallback: e.target.checked })
                    }
                    className="w-4 h-4 accent-emerald-600 cursor-pointer"
                  />
                  <span className="text-[11px] font-medium text-slate-700 whitespace-nowrap">
                    فعال
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-medium text-slate-700">
                    کلید رایگان OpenRouter (اختیاری)
                  </label>
                  <input
                    type="password"
                    dir="ltr"
                    value={settings.openrouterApiKey || ""}
                    onChange={(e) => onChange({ ...settings, openrouterApiKey: e.target.value })}
                    placeholder="sk-or-v1-..."
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-emerald-600 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 leading-snug">
                    openrouter.ai/keys — مدل‌های :free مثل Gemma 4 و Nemotron
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-medium text-slate-700">
                    کلید رایگان Groq (اختیاری)
                  </label>
                  <input
                    type="password"
                    dir="ltr"
                    value={settings.groqApiKey || ""}
                    onChange={(e) => onChange({ ...settings, groqApiKey: e.target.value })}
                    placeholder="gsk_..."
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-emerald-600 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 leading-snug">
                    console.groq.com/keys — Llama و GPT-OSS با سرعت بالا
                  </p>
                </div>
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                هیچ‌کدام اجباری نیستند؛ بدون هیچ کلیدی هم Pollinations (بدون کلید API) به‌عنوان آخرین لایه فعال است، اما نسخه بدون کلیدش محدود به یک پاسخ در هر ۴۵ ثانیه است.
              </p>
            </div>

            {/* User-Added Custom Providers */}
            {customProviders.map((prov) => {
              const isSelected = activeProviderId === prov.id;
              const envHint = PROVIDER_PRESETS[prov.type]?.envVar ?? "CUSTOM_AI_API_KEY";
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
                        {prov.type === "pollinations" ? (
                          "بدون نیاز به کلید API"
                        ) : prov.apiKey ? (
                          <span className="text-emerald-700">
                            کلید شخصی ذخیره شده ({maskKeyDisplay(prov.apiKey)})
                          </span>
                        ) : (
                          <>
                            متغیر کلید روی سرور:{" "}
                            <code className="font-mono text-slate-600">{envHint}</code>
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

          {/* Add New External Provider Form (OpenRouter Free / Groq Free / Custom) */}
          <form
            onSubmit={handleAddProvider}
            className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-4"
          >
            <div className="text-xs font-semibold text-slate-800">
              افزودن ارائه‌دهنده جایگزین (مثل OpenRouter رایگان یا Groq)
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
                  placeholder="مثلاً OpenRouter رایگان"
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
                  placeholder="openrouter/free"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="md:col-span-2 space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  کلید API شخصی این سرویس (اختیاری — در صورت خالی بودن از کلید سرور استفاده می‌شود)
                </label>
                <input
                  type="password"
                  dir="ltr"
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  placeholder="sk-or-... یا gsk_..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 text-left focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>

            {providerFormError && (
              <p className="text-xs text-red-700">{providerFormError}</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-500 leading-relaxed max-w-lg">
                کلید شخصی شما فقط در مرورگر خودتان ذخیره شده و هنگام ارسال درخواست به سرور برای پردازش استفاده می‌شود.
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
