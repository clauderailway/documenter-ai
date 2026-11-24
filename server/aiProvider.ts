import net from "node:net";
import type { CustomProviderProfile, EnrichmentSettings } from "../src/types/product.ts";

export type ProviderType = CustomProviderProfile["type"];

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  custom: "",
  pollinations: "https://text.pollinations.ai/openai",
};

const ENV_KEY_NAMES: Record<ProviderType, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  custom: "CUSTOM_AI_API_KEY",
  pollinations: "",
};

// Keyless public endpoint used as the very last resort when no API key is configured.
const POLLINATIONS_TEXT_MODELS = ["openai-fast"];

const OPENROUTER_TEXT_MODELS = [
  "openrouter/free",
  "google/gemma-4-31b-it:free",
  "inclusionai/ling-3.2-flash:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "recursive/flint-v1.0:free",
  "liquid/lfm-3-1.7b:free",
];

const OPENROUTER_VISION_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "inclusionai/ling-3.2-flash:free",
  "particle-ai/particle-1:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

const GROQ_TEXT_MODELS = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "qwen/qwen3-32b",
  "llama-3.1-8b-instant",
];

const GROQ_VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];

const MODEL_SKIP_MS = 15 * 60 * 1000;
const AUTH_COOLDOWN_MS = 15 * 60 * 1000;
const BUSY_COOLDOWN_MS = 90 * 1000;

const modelCooldownUntil = new Map<string, number>();

function isKeylessProvider(type: ProviderType): boolean {
  return type === "pollinations";
}

function freeModelsFor(type: ProviderType, needsVision: boolean): string[] {
  switch (type) {
    case "openrouter":
      return needsVision ? OPENROUTER_VISION_MODELS : OPENROUTER_TEXT_MODELS;
    case "groq":
      return needsVision ? GROQ_VISION_MODELS : GROQ_TEXT_MODELS;
    case "pollinations":
      return needsVision ? [] : POLLINATIONS_TEXT_MODELS;
    default:
      return [];
  }
}

function isPrivateOrBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  ) {
    return true;
  }

  const ipType = net.isIP(host);
  if (ipType === 4) {
    const parts = host.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (ipType === 6) {
    if (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:127.") ||
      host.startsWith("::ffff:10.") ||
      host.startsWith("::ffff:169.254.") ||
      host.startsWith("::ffff:192.168.")
    ) {
      return true;
    }
  }

  return false;
}

export function validateExternalProviderBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("آدرس Base URL ارائه‌دهنده معتبر نیست.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("آدرس ارائه‌دهنده باید با https:// شروع شود.");
  }

  if (isPrivateOrBlockedHostname(parsed.hostname)) {
    throw new Error("آدرس ارائه‌دهنده مجاز نیست (باید دامنه عمومی HTTPS باشد).");
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function resolveActiveCustomProvider(
  settings?: EnrichmentSettings
): CustomProviderProfile | null {
  if (!settings || !settings.aiProviderId || settings.aiProviderId === "gemini-default") {
    return null;
  }
  const found = (settings.customProviders || []).find((p) => p.id === settings.aiProviderId);
  return found ?? null;
}

function resolveProviderServerKey(type: ProviderType): string {
  switch (type) {
    case "openrouter":
      return (process.env.OPENROUTER_API_KEY || process.env.CUSTOM_AI_API_KEY || "").trim();
    case "openai":
      return (process.env.OPENAI_API_KEY || process.env.CUSTOM_AI_API_KEY || "").trim();
    case "groq":
      return (process.env.GROQ_API_KEY || process.env.CUSTOM_AI_API_KEY || "").trim();
    case "custom":
      return (
        process.env.CUSTOM_AI_API_KEY ||
        process.env.OPENROUTER_API_KEY ||
        process.env.OPENAI_API_KEY ||
        ""
      ).trim();
    case "pollinations":
      return "";
  }
}

export function resolveProviderKey(type: ProviderType, explicitKey?: string): string {
  const trimmed = (explicitKey || "").trim();
  if (trimmed) return trimmed;
  return resolveProviderServerKey(type);
}

export interface ProviderEngine {
  key: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = (raw || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function buildCustomEngine(
  profile: CustomProviderProfile,
  needsVision: boolean
): ProviderEngine | null {
  const type = profile.type;
  const apiKey = resolveProviderKey(type, profile.apiKey);
  if (!apiKey && !isKeylessProvider(type)) return null;

  const rawBaseUrl = (profile.baseUrl || "").trim() || DEFAULT_BASE_URLS[type];
  if (!rawBaseUrl) return null;

  const extraModels = freeModelsFor(type, needsVision);
  const models = dedupeModels([profile.model, ...extraModels]);
  if (models.length === 0) return null;

  return {
    key: `custom:${profile.id}`,
    name: profile.name || type,
    type,
    baseUrl: rawBaseUrl,
    apiKey,
    models,
  };
}

function buildAutoFreeEngines(
  settings: EnrichmentSettings | undefined,
  needsVision: boolean,
  skipTypes: Set<string>
): ProviderEngine[] {
  const engines: ProviderEngine[] = [];

  const candidates: Array<{ type: ProviderType; name: string; key: string }> = [
    {
      type: "openrouter",
      name: "OpenRouter Free",
      key: resolveProviderKey("openrouter", settings?.openrouterApiKey),
    },
    {
      type: "groq",
      name: "Groq Free",
      key: resolveProviderKey("groq", settings?.groqApiKey),
    },
    { type: "pollinations", name: "Pollinations (بدون کلید)", key: "" },
  ];

  for (const candidate of candidates) {
    const isKeyless = isKeylessProvider(candidate.type);
    if (!candidate.key && !isKeyless) continue;
    if (skipTypes.has(`${candidate.type}:${candidate.key}`)) continue;

    const models = freeModelsFor(candidate.type, needsVision);
    if (models.length === 0) continue;

    engines.push({
      key: `auto:${candidate.type}`,
      name: candidate.name,
      type: candidate.type,
      baseUrl: DEFAULT_BASE_URLS[candidate.type],
      apiKey: candidate.key,
      models,
    });
  }

  return engines;
}

export function buildProviderEngines(
  settings: EnrichmentSettings | undefined,
  options: { needsVision: boolean }
): ProviderEngine[] {
  const { needsVision } = options;
  const engines: ProviderEngine[] = [];
  const seenTypes = new Set<string>();

  const selected = resolveActiveCustomProvider(settings);
  if (selected) {
    const engine = buildCustomEngine(selected, needsVision);
    if (engine) {
      engines.push(engine);
      seenTypes.add(`${engine.type}:${engine.apiKey}`);
    }
  }

  for (const profile of settings?.customProviders || []) {
    if (selected && profile.id === selected.id) continue;
    const engine = buildCustomEngine(profile, needsVision);
    if (!engine) continue;
    const identity = `${engine.type}:${engine.apiKey}`;
    if (seenTypes.has(identity)) continue;
    seenTypes.add(identity);
    engines.push(engine);
  }

  if (settings?.autoFreeFallback !== false) {
    engines.push(...buildAutoFreeEngines(settings, needsVision, seenTypes));
  }

  return engines;
}

class ProviderRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}

const JSON_FORMAT_UNSUPPORTED = /response_format|json_object|structured/i;

async function requestChatCompletion(params: {
  engine: ProviderEngine;
  model: string;
  prompt: string;
  imageBase64?: string | null;
  imageMimeType?: string;
  timeoutMs: number;
  useJsonFormat: boolean;
}): Promise<string> {
  const {
    engine,
    model,
    prompt,
    imageBase64,
    imageMimeType = "image/webp",
    timeoutMs,
    useJsonFormat,
  } = params;

  const baseUrl = validateExternalProviderBaseUrl(engine.baseUrl);
  const endpoint = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const userContent =
    imageBase64 && imageMimeType.startsWith("image/")
      ? [
          {
            type: "image_url",
            image_url: {
              url: `data:${imageMimeType};base64,${imageBase64}`,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ]
      : prompt;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (engine.apiKey) {
    headers.Authorization = `Bearer ${engine.apiKey}`;
  }
  if (engine.type === "openrouter") {
    headers["HTTP-Referer"] = process.env.APP_URL || "https://kalasaz.app";
    headers["X-Title"] = "Kalasaz";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
      ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawText = await res.text();

  if (!res.ok) {
    const snippet = rawText.slice(0, 300);
    if (res.status === 400 && useJsonFormat && JSON_FORMAT_UNSUPPORTED.test(snippet)) {
      return requestChatCompletion({ ...params, useJsonFormat: false });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderRequestError(
        `خطای احراز هویت (${res.status}) از «${engine.name}». کلید API را در تنظیمات بررسی کنید.`,
        res.status
      );
    }
    if (res.status === 402) {
      throw new ProviderRequestError(`اعتبار/سهمیه «${engine.name}» کافی نیست: ${snippet}`, res.status);
    }
    if (res.status === 429) {
      throw new ProviderRequestError(`429 سهمیه/محدودیت نرخ از «${engine.name}»: ${snippet}`, 429);
    }
    if (res.status >= 500) {
      throw new ProviderRequestError(`503 سرویس «${engine.name}» در دسترس نیست: ${snippet}`, res.status);
    }
    throw new ProviderRequestError(`خطا از «${engine.name}» (${res.status}): ${snippet}`, res.status);
  }

  const data = JSON.parse(rawText) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  throw new ProviderRequestError(`پاسخ متنی معتبری از «${engine.name}» دریافت نشد.`, 502);
}

export interface AutoFallbackResult {
  text: string;
  providerName: string;
  model: string;
}

export async function generateJsonWithAutoFallback(params: {
  settings?: EnrichmentSettings;
  prompt: string;
  imageBase64?: string | null;
  imageMimeType?: string;
  timeoutMs?: number;
  totalBudgetMs?: number;
  needsVision?: boolean;
  validate?: (text: string) => void;
}): Promise<AutoFallbackResult> {
  const {
    settings,
    prompt,
    imageBase64,
    imageMimeType = "image/webp",
    timeoutMs = 45000,
    totalBudgetMs = 80000,
    needsVision = Boolean(imageBase64),
    validate,
  } = params;

  const engines = buildProviderEngines(settings, { needsVision });

  if (engines.length === 0) {
    throw new Error(
      needsVision
        ? "برای تحلیل تصویر به یک سرویس بینایی نیاز است. یک کلید رایگان Gemini، OpenRouter یا Groq را در تنظیمات وارد کنید."
        : "هیچ سرویس هوش مصنوعی رایگانی در دسترس نیست. در تنظیمات یک کلید Gemini، OpenRouter یا Groq وارد کنید."
    );
  }

  const deadline = Date.now() + totalBudgetMs;
  const errors: string[] = [];
  let skippedByCooldown = 0;

  for (const engine of engines) {
    for (const model of engine.models) {
      if (Date.now() >= deadline - 1500) break;

      const cooldownKey = `${engine.key}::${model}`;
      const cooldownUntil = modelCooldownUntil.get(cooldownKey) ?? 0;
      if (Date.now() < cooldownUntil) {
        skippedByCooldown += 1;
        continue;
      }

      const remainingMs = deadline - Date.now();
      const attemptTimeout = Math.min(timeoutMs, Math.max(6000, remainingMs - 500));

      try {
        const text = await requestChatCompletion({
          engine,
          model,
          prompt,
          imageBase64,
          imageMimeType,
          timeoutMs: attemptTimeout,
          useJsonFormat: true,
        });

        if (validate) {
          try {
            validate(text);
          } catch {
            errors.push(`${engine.name}/${model}: پاسخ JSON نامعتبر`);
            modelCooldownUntil.set(cooldownKey, Date.now() + BUSY_COOLDOWN_MS);
            continue;
          }
        }

        modelCooldownUntil.delete(cooldownKey);
        console.log(`[AI] پاسخ از ${engine.name} (${model})`);
        return { text, providerName: engine.name, model };
      } catch (err) {
        const status = err instanceof ProviderRequestError ? err.status : 0;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${engine.name}/${model}: ${message}`);

        if (status === 401 || status === 403) {
          modelCooldownUntil.set(cooldownKey, Date.now() + AUTH_COOLDOWN_MS);
          break;
        }
        if (status === 402) {
          const retryMatch = message.match(/retry after\s+(\d+)\s*s/i);
          if (retryMatch) {
            const waitMs = Math.min(
              Math.max(Number(retryMatch[1]) + 3, 5) * 1000,
              AUTH_COOLDOWN_MS
            );
            modelCooldownUntil.set(cooldownKey, Date.now() + waitMs);
            continue;
          }
          modelCooldownUntil.set(cooldownKey, Date.now() + AUTH_COOLDOWN_MS);
          break;
        }
        if (status === 404 || status === 400 || status === 422) {
          modelCooldownUntil.set(cooldownKey, Date.now() + MODEL_SKIP_MS);
          continue;
        }
        modelCooldownUntil.set(cooldownKey, Date.now() + BUSY_COOLDOWN_MS);
      }
    }

    if (Date.now() >= deadline - 1500) break;
  }

  const detail = errors.slice(-4).join(" | ");
  if (errors.length === 0 && skippedByCooldown > 0) {
    throw new Error(
      "429 همه سرویس‌های رایگان موقتاً به محدودیت نرخ خورده‌اند. حدود یک دقیقه صبر کنید و دوباره تلاش کنید."
    );
  }
  throw new Error(
    `همه سرویس‌های هوش مصنوعی پاسخ ندادند${detail ? `: ${detail}` : "."}`
  );
}
