import { GoogleGenAI } from "@google/genai";
import type { EnrichmentSettings, ProductSource, ProductSpec } from "../src/types/product.ts";
import {
  generateJsonWithAutoFallback,
  resolveActiveCustomProvider,
} from "./aiProvider.ts";
import { searchWebProductImages } from "./imagePipeline.ts";

let searchToolBlockedUntil = 0;

// Track per-model temporary cooldowns when a specific pool returns 503/429/404
// so consecutive batch items immediately route to a healthy responsive model.
const modelCooldownUntil = new Map<string, number>();
let lastHealthyModel: string | null = null;

interface ModelCandidate {
  id: string;
}

// All of these are free-tier models on the Gemini Developer API.
// Order is quality-first, then cheaper/higher-quota models as automatic failover.
const TEXT_MODEL_POOL: ModelCandidate[] = [
  { id: "gemini-3.8-flash" },
  { id: "gemini-3.6-flash" },
  { id: "gemini-3.5-flash-lite" },
  { id: "gemini-4-hydrogen" },
  { id: "gemini-3.1-flash-lite" },
  { id: "gemma-4-31b-it" },
  { id: "gemma-4-26b-a4b-it" },
  { id: "gemini-2.5-flash" },
];

const PERMANENT_SKIP_MS = 15 * 60 * 1000;
const BUSY_COOLDOWN_MS = 90 * 1000;

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(customApiKey?: string): GoogleGenAI {
  const trimmedCustom = customApiKey?.trim();
  if (trimmedCustom) {
    return new GoogleGenAI({
      apiKey: trimmedCustom,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

export interface GeminiProductResearchResult {
  titleFa: string;
  titleEn: string;
  slug: string;
  brand: string;
  category: string;
  modelCode: string;
  shortDescription: string;
  longDescription: string;
  longDescriptionHtml: string;
  specs: ProductSpec[];
  candidatePageUrls: string[];
  directImageUrls: string[];
  sources: ProductSource[];
  searchQueries: string[];
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<\/(h[1-6]|p|div|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("پاسخ ساختاریافته از موتور جستجو دریافت نشد.");
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice) as Record<string, unknown>;
}

function extractDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthOrFatalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("UNAUTHENTICATED") ||
    msg.includes("API key not valid") ||
    msg.includes("401") ||
    msg.includes("403")
  );
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("NOT_FOUND") || msg.includes("404");
}

function isModelConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("INVALID_ARGUMENT") ||
    msg.includes("FAILED_PRECONDITION") ||
    msg.includes("400")
  );
}

function hasGeminiCredentials(settings?: EnrichmentSettings): boolean {
  return Boolean(
    (settings?.geminiApiKey || "").trim() || (process.env.GEMINI_API_KEY || "").trim()
  );
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
}

function isBusyOrTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("INTERNAL") ||
    msg.includes("TIMEOUT") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT")
  );
}

function isRetryableModelError(err: unknown): boolean {
  return (
    isNotFoundError(err) ||
    isModelConfigError(err) ||
    isQuotaError(err) ||
    isBusyOrTransientError(err)
  );
}

function getOrderedModelPool(includeCooledDown: boolean): ModelCandidate[] {
  const now = Date.now();
  const base = [...TEXT_MODEL_POOL];

  // Prioritize the last known responsive model so consecutive queue items succeed immediately
  if (lastHealthyModel) {
    const idx = base.findIndex((m) => m.id === lastHealthyModel);
    if (idx > 0) {
      const [healthy] = base.splice(idx, 1);
      base.unshift(healthy);
    }
  }

  const ready: ModelCandidate[] = [];
  const cooledBusy: ModelCandidate[] = [];

  for (const m of base) {
    const until = modelCooldownUntil.get(m.id) ?? 0;
    if (now >= until) {
      ready.push(m);
    } else if (includeCooledDown && until - now <= BUSY_COOLDOWN_MS + 5000) {
      cooledBusy.push(m);
    }
  }

  return includeCooledDown ? [...ready, ...cooledBusy] : ready;
}

async function callGenerateContentWithTimeout(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
  timeoutMs: number
): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ai.models.generateContent(params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`UPSTREAM_TIMEOUT_${timeoutMs}MS`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeCandidate(
  ai: GoogleGenAI,
  candidate: ModelCandidate,
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"],
  jsonMode: boolean,
  timeoutMs: number
): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  try {
    const response = await callGenerateContentWithTimeout(
      ai,
      {
        model: candidate.id,
        contents,
        config: {
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      },
      timeoutMs
    );

    modelCooldownUntil.delete(candidate.id);
    lastHealthyModel = candidate.id;
    return response;
  } catch (err) {
    if (isNotFoundError(err) || isModelConfigError(err)) {
      modelCooldownUntil.set(candidate.id, Date.now() + PERMANENT_SKIP_MS);
      if (lastHealthyModel === candidate.id) lastHealthyModel = null;
    } else if (isQuotaError(err) || isBusyOrTransientError(err)) {
      modelCooldownUntil.set(candidate.id, Date.now() + BUSY_COOLDOWN_MS);
      if (lastHealthyModel === candidate.id) lastHealthyModel = null;
    }
    throw err;
  }
}

async function generateWithResilientModels(options: {
  ai: GoogleGenAI;
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"];
  jsonMode: boolean;
  timeoutMs: number;
  maxRounds?: number;
  totalBudgetMs?: number;
}): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  const {
    ai,
    contents,
    jsonMode,
    timeoutMs,
    maxRounds = 2,
    totalBudgetMs = 42000,
  } = options;
  const deadline = Date.now() + totalBudgetMs;
  let lastError: unknown = null;

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() >= deadline - 1500) break;

    const candidates = getOrderedModelPool(round > 0);
    const listToTry = candidates.length > 0 ? candidates : getOrderedModelPool(true);
    if (listToTry.length === 0) break;

    for (let i = 0; i < listToTry.length; i++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 3000) break;

      const candidate = listToTry[i];
      const attemptTimeout = Math.min(timeoutMs, Math.max(5000, remainingMs - 500));
      try {
        return await invokeCandidate(ai, candidate, contents, jsonMode, attemptTimeout);
      } catch (err) {
        lastError = err;
        if (isAuthOrFatalError(err) || !isRetryableModelError(err)) {
          throw err;
        }
        // Small jittered pause before next fallback model to avoid burst load-shedding
        if (i < listToTry.length - 1 && deadline - Date.now() > 4000) {
          await sleep(300 + Math.floor(Math.random() * 200));
        }
      }
    }

    if (round < maxRounds - 1 && deadline - Date.now() > 6000) {
      const backoffMs = 1200 + Math.floor(Math.random() * 500);
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("503 UNAVAILABLE: امکان دریافت پاسخ از سرویس پردازش وجود نداشت.");
}

interface LiveFallbackWebContext {
  contextSummary: string;
  pageUrls: string[];
  imageUrls: string[];
  sources: ProductSource[];
}

async function fetchLiveWebContextFallback(query: string): Promise<LiveFallbackWebContext> {
  const pageUrls: string[] = [];
  const imageUrls: string[] = [];
  const sources: ProductSource[] = [];
  const snippets: string[] = [];

  const fetchWiki = async (lang: "fa" | "en") => {
    try {
      const wikiRes = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
          query
        )}&format=json&srlimit=2`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (!wikiRes.ok) return [];
      const wikiData = (await wikiRes.json()) as {
        query?: { search?: Array<{ title?: string; snippet?: string }> };
      };
      return (wikiData?.query?.search ?? []).map((hit) => ({ lang, hit }));
    } catch {
      return [];
    }
  };

  // Fetch web image/store hits and FA/EN Wikipedia snippets in parallel for fast fallback context
  const [webHits, wikiFa, wikiEn] = await Promise.all([
    searchWebProductImages(query).catch(() => []),
    fetchWiki("fa"),
    fetchWiki("en"),
  ]);

  for (const hit of webHits.slice(0, 8)) {
    if (hit.imageUrl && !imageUrls.includes(hit.imageUrl)) {
      imageUrls.push(hit.imageUrl);
    }
    if (hit.pageUrl && !pageUrls.includes(hit.pageUrl)) {
      pageUrls.push(hit.pageUrl);
      sources.push({
        title: hit.title || extractDomain(hit.pageUrl),
        url: hit.pageUrl,
        domain: extractDomain(hit.pageUrl),
      });
    }
    if (hit.title) {
      snippets.push(`- منبع وب (${extractDomain(hit.pageUrl)}): ${hit.title}`);
    }
  }

  for (const { lang, hit } of [...wikiFa, ...wikiEn]) {
    if (hit.title) {
      const cleanSnippet = (hit.snippet || "").replace(/<[^>]+>/g, " ").trim();
      snippets.push(`- دانشنامه (${lang}): ${hit.title} — ${cleanSnippet}`);
      const wikiUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
        hit.title.replace(/\s+/g, "_")
      )}`;
      if (!pageUrls.includes(wikiUrl)) {
        pageUrls.push(wikiUrl);
        sources.push({
          title: hit.title,
          url: wikiUrl,
          domain: `${lang}.wikipedia.org`,
        });
      }
    }
  }

  return {
    contextSummary: snippets.join("\n"),
    pageUrls,
    imageUrls,
    sources,
  };
}

export async function researchProductWithGemini(
  query: string,
  settings: EnrichmentSettings,
  options?: {
    seedImageBase64?: string | null;
    seedUrl?: string;
  }
): Promise<GeminiProductResearchResult> {
  const toneGuide =
    settings.tone === "technical"
      ? "لحن دقیق، فنی و مهندسی با تمرکز بر مشخصات سخت‌افزاری، دقت سنجش، استانداردها و اعداد واقعی"
      : settings.tone === "minimal"
        ? "لحن کوتاه، سرراست و مینیمال بدون حاشیه"
        : "لحن حرفه‌ای، تخصصی، اعتمادبخش و فروشگاهی مناسب فروشگاه اینترنتی و سئو";

  const langGuide =
    settings.outputLanguage === "en"
      ? "تمام فیلدهای متنی (titleFa را هم به عنوان عنوان اصلی و shortDescription و longDescription) به زبان انگلیسی استاندارد بنویس."
      : settings.outputLanguage === "fa_en"
        ? "توضیحات را به زبان فارسی روان و استاندارد بنویس ولی نام مدل، اصطلاحات پزشکی/فنی کلیدی و عنوان انگلیسی را دقیق حفظ کن."
        : "تمام توضیحات، عنوان فارسی، ویژگی‌ها و جدول مشخصات را به زبان فارسی روان، دقیق و بدون غلط املایی بنویس و عنوان انگلیسی دقیق مدل را هم در titleEn قرار بده.";

  const medicalDomainGuide =
    settings.domainProfile === "medical"
      ? `
حوزه تخصصی فروشگاه: تجهیزات پزشکی، تشخیصی، بیمارستانی، کلینیکی و مراقبت سلامت (برای فروشگاه وردپرس/ووکامرس ${settings.storeName || "آرال هلث"}).
نکات تخصصی تجهیزات پزشکی:
- category را متناسب با ساختار دسته‌بندی تجهیزات پزشکی ووکامرس بنویس (مثلاً: «تجهیزات پزشکی > دستگاه فشارسنج»، «تجهیزات پزشکی > تجهیزات تشخیصی و معاینه»، «تجهیزات پزشکی > تجهیزات مراقبت از نوزاد و بیمار»، «تجهیزات پزشکی > تجهیزات تنفسی»، «تجهیزات پزشکی > تجهیزات مصرفی پزشکی»).
- در longDescription و longDescriptionHtml ساختار زیر را رعایت کن:
  ۱) معرفی تخصصی محصول و کاربرد بالینی/درمانی یا خانگی
  ۲) مشخصات طراحی، ایمنی، بهداشت و فناوری ساخت
  ۳) نکات استفاده صحیح، شست‌وشو یا استریل‌کردن و نگهداری
  ۴) راهنمای انتخاب برای کلینیک‌ها، مطب‌ها یا مصرف خانگی
- در specs ویژگی‌های کلیدی تجهیزات پزشکی را با دقت بیاور (مثل برند/نوع، جنس بدنه/سری، کاربرد، قابلیت شست‌وشو/ضدعفونی، رده سنی یا گروه هدف، ابعاد/ظرفیت، اقلام همراه).
`
      : "";

  const seedHintText = options?.seedImageBase64
    ? `
توجه بسیار مهم: یک تصویر واقعی از محصول پیوست شده است. ابتدا مدل، برند و نوع دقیق کالا را از روی ظاهر، لیبل، لوگو و جزئیات تصویر پیوست‌شده (در کنار نام/راهنمای "${query}") تشخیص بده.`
    : "";

  const seedUrlText = options?.seedUrl
    ? `\nلینک مرجع یا تصویر معرفی‌شده توسط کاربر: ${options.seedUrl}`
    : "";

  const buildPrompt = (extraWebContext?: string) =>
    `
شما یک متخصص حرفه‌ای تدوین اطلاعات کالا و کاتالوگ فروشگاه اینترنتی هستید.
اطلاعات ورودی کاربر برای محصول:
"${query}"
${seedHintText}${seedUrlText}
${medicalDomainGuide}
${extraWebContext ? `\nنتایج به‌دست‌آمده از جستجوی وب:\n${extraWebContext}\n` : ""}
ماموریت شما:
بر اساس اطلاعات واقعی محصول، یک خروجی کامل JSON با ساختار زیر تولید کنید.

راهنمای نگارش:
- ${langGuide}
- ${toneGuide}
- اگر نام واردشده عمومی است (مثلاً «پوار بینی» یا «گوشی پزشکی» یا «فشارسنج عقربه‌ای»)، عنوان استاندارد و جامع فارسی و انگلیسی همان کالا را تولید کن و در صورت عدم ذکر برند، برند را خالی یا «متفرقه / استاندارد» بگذار و مشخصات واقعی استاندارد آن تجهیز پزشکی را بنویس.
- shortDescription: فهرستی از ۴ تا ۶ گزینه کوتاه و کاربردی (هر گزینه در یک خط مجزا، جداشده با \\n، بدون علامت - یا * یا شماره در ابتدای خط و بدون پاراگراف طولانی). مثال دقیق فرمت برای جوراب واریس ورنا AF:
جلوگیری از انسداد جریان خون
جلوگیری از ایجاد و پیشرفت واریس
اعمال فشار لازم به منظور رفع خستگی
مناسب برای بهبود گردش خون و پیشگیری از تورم پا
- longDescriptionHtml: یک توضیح بلند کامل، جامع و خوانا (۴ بخش منظم) به صورت HTML تمیز و استاندارد آماده انتشار در ووکامرس/وردپرس (فقط تگ‌های <h2>، <h3>، <p>، <ul>، <li>، <strong>). بسیار مهم: جمله اول اولین <p> حتماً باید با نام کامل محصول و اسم برند شروع شود (مثلاً <p><strong>جوراب واریس ورنا AF</strong> ...</p>). از جملات کلیشه‌ای مثل «در دنیای امروز» یا «این محصول یکی از» در شروع متن استفاده نکن و از علائم Markdown خام مثل ** یا ### استفاده نکن.
- specs: آرایه‌ای از ۶ تا ۱۰ مشخصه فنی دقیق و کاربردی.
- candidatePageUrls: لیستی از آدرس‌های واقعی مرتبط (اگر یافت نشد آرایه خالی بگذارید؛ هرگز لینک جعلی نسازید).
- directImageUrls: آرایه خالی یا لینک مستقیم واقعی یافت‌شده (هرگز لینک جعلی نسازید).
- slug: نامک انگلیسی SEO-friendly با حروف کوچک و خط تیره (مثلا varna-af-compression-stocking).

فقط یک آبجکت JSON معتبر با کلیدهای دقیق زیر برگردانید و هیچ متن اضافه قبل یا بعد از JSON ننویسید:
{
  "titleFa": "عنوان استاندارد و کامل فارسی محصول",
  "titleEn": "Official English Product Title",
  "slug": "english-seo-slug",
  "brand": "نام برند یا خالی",
  "category": "دسته‌بندی کالا",
  "modelCode": "کد مدل یا خالی",
  "shortDescription": "گزینه اول\\nگزینه دوم\\nگزینه سوم\\nگزینه چهارم",
  "longDescriptionHtml": "<p><strong>نام کامل محصول و برند</strong> ...</p><h2>...</h2>",
  "specs": [
    { "label": "عنوان ویژگی", "value": "مقدار دقیق" }
  ],
  "candidatePageUrls": [],
  "directImageUrls": []
}
`.trim();

  const buildContents = (promptText: string) =>
    options?.seedImageBase64
      ? {
          parts: [
            {
              inlineData: {
                mimeType: "image/webp",
                data: options.seedImageBase64,
              },
            },
            { text: promptText },
          ],
        }
      : promptText;

  type GenerateContentResult = Awaited<
    ReturnType<GoogleGenAI["models"]["generateContent"]>
  >;

  const responseBox: { value: GenerateContentResult | null } = { value: null };
  const parsedBox: { value: Record<string, unknown> | null } = { value: null };
  const contextBox: { value: LiveFallbackWebContext | null } = { value: null };
  let lastError: unknown = null;

  const ai = hasGeminiCredentials(settings) ? getGeminiClient(settings.geminiApiKey) : null;
  const externalFirst = Boolean(resolveActiveCustomProvider(settings));

  const ensureFallbackContext = async (): Promise<LiveFallbackWebContext> => {
    if (!contextBox.value) {
      contextBox.value = await fetchLiveWebContextFallback(query);
    }
    return contextBox.value;
  };

  const tryExternalProvider = async (): Promise<boolean> => {
    const context = await ensureFallbackContext();
    const external = await generateJsonWithAutoFallback({
      settings,
      prompt: buildPrompt(context.contextSummary),
      imageBase64: options?.seedImageBase64,
      imageMimeType: "image/webp",
      timeoutMs: 45000,
      totalBudgetMs: 60000,
      needsVision: Boolean(options?.seedImageBase64),
      validate: (text) => {
        extractJsonObject(text);
      },
    });
    parsedBox.value = extractJsonObject(external.text);
    return true;
  };

  const tryGeminiSearchGrounding = async (): Promise<boolean> => {
    if (!ai || Date.now() < searchToolBlockedUntil) return false;

    const searchModels = getOrderedModelPool(false).slice(0, 2);
    for (const candidate of searchModels) {
      if (Date.now() < searchToolBlockedUntil) break;
      try {
        const candidateResp = await callGenerateContentWithTimeout(
          ai,
          {
            model: candidate.id,
            contents: buildContents(buildPrompt()),
            config: {
              tools: [{ googleSearch: {} }],
            },
          },
          16000
        );
        parsedBox.value = extractJsonObject(candidateResp.text ?? "");
        responseBox.value = candidateResp;
        modelCooldownUntil.delete(candidate.id);
        lastHealthyModel = candidate.id;
        return true;
      } catch (err) {
        lastError = err;
        if (isQuotaError(err)) {
          // Search grounding quota exhausted (common on free tier): cool down search only
          searchToolBlockedUntil = Date.now() + 15 * 60 * 1000;
          break;
        }
        if (isNotFoundError(err) || isModelConfigError(err)) {
          modelCooldownUntil.set(candidate.id, Date.now() + PERMANENT_SKIP_MS);
          continue;
        }
        if (isBusyOrTransientError(err)) {
          modelCooldownUntil.set(candidate.id, Date.now() + BUSY_COOLDOWN_MS);
          continue;
        }
        // Auth errors or invalid JSON from search mode fall through to structured mode
        break;
      }
    }
    return false;
  };

  const tryGeminiStructuredJson = async (): Promise<boolean> => {
    if (!ai) return false;

    const context = await ensureFallbackContext();
    const contents = buildContents(buildPrompt(context.contextSummary));

    for (let parseTry = 0; parseTry < 2; parseTry++) {
      try {
        const candidateResp = await generateWithResilientModels({
          ai,
          contents,
          jsonMode: true,
          timeoutMs: 22000,
          maxRounds: 2,
          totalBudgetMs: 40000,
        });
        parsedBox.value = extractJsonObject(candidateResp.text ?? "");
        responseBox.value = candidateResp;
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    return false;
  };

  const tryGemini = async (): Promise<boolean> => {
    if (!ai) return false;
    try {
      if (await tryGeminiSearchGrounding()) return true;
    } catch (err) {
      lastError = err;
    }
    return tryGeminiStructuredJson();
  };

  if (externalFirst) {
    try {
      await tryExternalProvider();
    } catch (err) {
      lastError = err;
    }
  }

  if (!parsedBox.value) {
    await tryGemini();
  }

  if (!parsedBox.value) {
    try {
      await tryExternalProvider();
    } catch (err) {
      lastError = err;
    }
  }

  if (!parsedBox.value) {
    throw lastError instanceof Error
      ? lastError
      : new Error("پاسخ ساختاریافته از موتور پردازش دریافت نشد.");
  }

  const parsed = parsedBox.value;
  const fallbackContext = contextBox.value;

  const groundingMeta = responseBox.value?.candidates?.[0]?.groundingMetadata;
  const rawChunks = groundingMeta?.groundingChunks ?? [];
  const searchQueries = groundingMeta?.webSearchQueries ?? [];

  const sources: ProductSource[] = [];
  const seenUrls = new Set<string>();

  for (const chunk of rawChunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title || "منبع وب";
    if (uri && !seenUrls.has(uri)) {
      seenUrls.add(uri);
      sources.push({
        title,
        url: uri,
        domain: extractDomain(uri),
      });
    }
  }

  if (fallbackContext) {
    for (const s of fallbackContext.sources) {
      if (!seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        sources.push(s);
      }
    }
  }

  const candidatePageUrls: string[] = Array.isArray(parsed.candidatePageUrls)
    ? parsed.candidatePageUrls.filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    : [];

  if (fallbackContext) {
    for (const u of fallbackContext.pageUrls) {
      if (!candidatePageUrls.includes(u)) candidatePageUrls.push(u);
    }
  }

  for (const u of candidatePageUrls) {
    if (!seenUrls.has(u)) {
      seenUrls.add(u);
      sources.push({
        title: extractDomain(u),
        url: u,
        domain: extractDomain(u),
      });
    }
  }

  const directImageUrls: string[] = Array.isArray(parsed.directImageUrls)
    ? parsed.directImageUrls.filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    : [];

  if (fallbackContext) {
    for (const img of fallbackContext.imageUrls) {
      if (!directImageUrls.includes(img)) directImageUrls.push(img);
    }
  }

  const specs: ProductSpec[] = Array.isArray(parsed.specs)
    ? parsed.specs
        .filter(
          (s): s is { label: string; value: string } =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as Record<string, unknown>).label === "string" &&
            typeof (s as Record<string, unknown>).value === "string"
        )
        .map((s) => ({ label: s.label.trim(), value: s.value.trim() }))
    : [];

  const titleEn = typeof parsed.titleEn === "string" ? parsed.titleEn.trim() : query;
  const fallbackSlug =
    titleEn
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `product-${Date.now()}`;

  const rawShort = parsed.shortDescription;
  const normalizedShortDescription = Array.isArray(rawShort)
    ? rawShort
        .filter((x): x is string => typeof x === "string")
        .map((line) => line.replace(/^[\s•\-*·\d.۰-۹)]+/, "").trim())
        .filter(Boolean)
        .join("\n")
    : typeof rawShort === "string"
      ? rawShort
          .split(/\r?\n/)
          .map((line) => line.replace(/^[\s•\-*·\d.۰-۹)]+/, "").trim())
          .filter(Boolean)
          .join("\n")
      : "";

  const longDescriptionHtml =
    typeof parsed.longDescriptionHtml === "string" ? parsed.longDescriptionHtml.trim() : "";
  const rawLongDesc =
    typeof parsed.longDescription === "string" ? parsed.longDescription.trim() : "";
  const longDescription = rawLongDesc || (longDescriptionHtml ? htmlToPlainText(longDescriptionHtml) : "");

  return {
    titleFa: typeof parsed.titleFa === "string" && parsed.titleFa.trim() ? parsed.titleFa.trim() : query,
    titleEn,
    slug:
      typeof parsed.slug === "string" && parsed.slug.trim()
        ? parsed.slug.trim().toLowerCase()
        : fallbackSlug,
    brand: typeof parsed.brand === "string" ? parsed.brand.trim() : "",
    category: typeof parsed.category === "string" ? parsed.category.trim() : "",
    modelCode: typeof parsed.modelCode === "string" ? parsed.modelCode.trim() : "",
    shortDescription: normalizedShortDescription,
    longDescription,
    longDescriptionHtml,
    specs,
    candidatePageUrls,
    directImageUrls,
    sources,
    searchQueries,
  };
}

export async function findMoreProductPagesWithGemini(
  productName: string,
  brand: string,
  isMedical = true,
  settings?: EnrichmentSettings
): Promise<string[]> {
  const ai = hasGeminiCredentials(settings) ? getGeminiClient(settings?.geminiApiKey) : null;

  const domainHint = isMedical
    ? "official medical device manufacturer product page, medical supply store, Amazon, or Digikala"
    : "official manufacturer product gallery page, press kit, Amazon, BestBuy, or Digikala";

  const prompt = `
Find 6 real, direct web page URLs (${domainHint}) that contain high-resolution product photos for:
Product: "${productName}" ${brand ? `(Brand: ${brand})` : ""}

Return ONLY a JSON object:
{
  "urls": ["https://..."]
}
`.trim();

  const urls = new Set<string>();

  if (ai && Date.now() >= searchToolBlockedUntil) {
    const modelsToTry = getOrderedModelPool(false).slice(0, 2);
    for (const candidate of modelsToTry) {
      if (Date.now() < searchToolBlockedUntil) break;
      try {
        const response = await callGenerateContentWithTimeout(
          ai,
          {
            model: candidate.id,
            contents: prompt,
            config: {
              tools: [{ googleSearch: {} }],
            },
          },
          15000
        );
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        for (const c of chunks) {
          if (c?.web?.uri) urls.add(c.web.uri);
        }
        try {
          const parsed = extractJsonObject(response.text ?? "");
          if (Array.isArray(parsed.urls)) {
            for (const u of parsed.urls) {
              if (typeof u === "string" && u.startsWith("http")) urls.add(u);
            }
          }
        } catch {
          // Grounding chunks are still valid
        }
        if (urls.size > 0) break;
      } catch (err) {
        if (isQuotaError(err)) {
          searchToolBlockedUntil = Date.now() + 15 * 60 * 1000;
          break;
        }
        if (!isRetryableModelError(err)) break;
      }
    }
  }

  const useExternal = urls.size === 0 && !ai;

  if (urls.size === 0 && useExternal) {
    try {
      const external = await generateJsonWithAutoFallback({
        settings,
        prompt,
        timeoutMs: 30000,
        totalBudgetMs: 40000,
        needsVision: false,
        validate: (text) => {
          extractJsonObject(text);
        },
      });
      const parsed = extractJsonObject(external.text);
      if (Array.isArray(parsed.urls)) {
        for (const u of parsed.urls) {
          if (typeof u === "string" && u.startsWith("http")) urls.add(u);
        }
      }
    } catch {
      // Fall through to live web search below
    }
  }

  // Fallback to live web search pages if Gemini search grounding is unavailable or empty
  if (urls.size === 0) {
    const live = await fetchLiveWebContextFallback(productName);
    for (const u of live.pageUrls) urls.add(u);
  }

  return Array.from(urls);
}

export async function extractProductListFromScan(params: {
  base64Data: string;
  mimeType: string;
  isMedical?: boolean;
  settings?: EnrichmentSettings;
}): Promise<{ items: string[]; note?: string }> {
  const ai = hasGeminiCredentials(params.settings) ? getGeminiClient(params.settings?.geminiApiKey) : null;
  const domainNote = params.isMedical
    ? "این برگه مربوط به لیست تجهیزات پزشکی و سلامت است؛ نام دستگاه، برند، مدل یا کد فنی (مثل BM28، YX306، سایز یا ظرفیت) را در صورت وجود در کنار نام کالا حفظ کن تا جستجو دقیق باشد."
    : "نام کالا، برند و کد مدل را در صورت وجود در کنار هم حفظ کن.";

  const prompt = `
تصویر یا فایل یک برگه A4 (چاپی، جدولی، فاکتور، لیست انبار یا دست‌نویس فارسی/انگلیسی) پیوست شده است.
ماموریت شما:
1. تمام سطرها و نام محصولات نوشته‌شده روی این برگه را با دقت بالا و املای صحیح بخوانید و استخراج کنید.
2. ${domainNote}
3. شماره ردیف (۱، ۲، ...), تیتر ستون‌ها (ردیف، نام کالا، تعداد، قیمت، فی، جمع، ملاحظات)، قیمت‌ها، تعداد، امضا، تاریخ، آدرس فروشگاه و خط‌تیره‌های خالی را حذف کنید و فقط نام دقیق هر محصول را استخراج کنید.
4. اگر در ستون جداگانه‌ای «برند» یا «مدل» نوشته شده بود، آن را به نام همان محصول اضافه کنید تا یک عبارت جستجوی کامل شود.
5. ترتیب کالاها را مطابق برگه حفظ کنید و موارد تکراری دقیق را حذف کنید.

فقط یک آبجکت JSON معتبر با ساختار دقیق زیر برگردانید:
{
  "items": [
    "نام کامل محصول اول",
    "نام کامل محصول دوم"
  ],
  "note": "توضیح کوتاه در صورت ناخوانا بودن بخشی از برگه یا خالی"
}
`.trim();

  const activeCustomProvider = resolveActiveCustomProvider(params.settings);
  const canUseExternal = Boolean(
    activeCustomProvider || params.settings?.autoFreeFallback !== false
  );
  const isImageInput = params.mimeType.startsWith("image/");

  if (!isImageInput && !ai) {
    throw new Error(
      "خواندن مستقیم فایل PDF فقط با کلید Gemini امکان‌پذیر است. لطفاً کلید Gemini را در تنظیمات وارد کنید یا فایل را به‌صورت عکس (JPG/PNG) ارسال کنید."
    );
  }

  let rawText: string | null = null;

  if (ai) {
    try {
      const response = await generateWithResilientModels({
        ai,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: params.mimeType,
                data: params.base64Data,
              },
            },
            { text: prompt },
          ],
        },
        jsonMode: true,
        timeoutMs: 20000,
        maxRounds: 1,
        totalBudgetMs: 38000,
      });
      rawText = response.text ?? null;
    } catch (err) {
      if (!canUseExternal) throw err;
    }
  }

  if (!rawText && canUseExternal) {
    const external = await generateJsonWithAutoFallback({
      settings: params.settings,
      prompt,
      imageBase64: isImageInput ? params.base64Data : null,
      imageMimeType: params.mimeType,
      timeoutMs: 45000,
      totalBudgetMs: 60000,
      needsVision: isImageInput,
      validate: (text) => {
        extractJsonObject(text);
      },
    });
    rawText = external.text;
  }

  if (!rawText) {
    throw new Error(
      "هیچ سرویس هوش مصنوعی در دسترس نیست. در تنظیمات یک کلید Gemini، OpenRouter یا Groq وارد کنید."
    );
  }

  const parsed = extractJsonObject(rawText);
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const note = typeof parsed.note === "string" ? parsed.note.trim() : undefined;
  return { items, note };
}
