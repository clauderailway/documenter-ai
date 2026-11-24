import crypto from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  EnrichmentSettings,
  GeminiModelMode,
  ProductSource,
  ProductSpec,
} from "../src/types/product.ts";
import {
  generateJsonWithAutoFallback,
  resolveActiveCustomProvider,
} from "./aiProvider.ts";
import { searchWebProductImages } from "./imagePipeline.ts";

let searchToolBlockedUntil = 0;

// Track per-(keyTag, modelId) temporary cooldowns so one key's rate limit never blocks another key
const keyModelCooldownUntil = new Map<string, number>();
const lastHealthyModelByKey = new Map<string, string>();
const modelsWithoutThinkingConfig = new Set<string>();
const clientCache = new Map<string, GoogleGenAI>();
let roundRobinKeyCursor = 0;

const discoveredModelsByKey = new Map<string, { expiresAt: number; models: ModelCandidate[] }>();

interface ModelCandidate {
  id: string;
  thinkingLevel?: ThinkingLevel;
  supportsJsonMode?: boolean;
}

function inferDefaultThinkingLevel(modelId: string): ThinkingLevel | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gemma-") || lower.startsWith("gemini-2.5")) return undefined;
  if (lower.includes("flash-lite")) return ThinkingLevel.MINIMAL;
  if (lower.startsWith("gemini-4") || lower.startsWith("gemini-3")) return ThinkingLevel.LOW;
  return undefined;
}

const ALL_GEMINI_MODELS: Record<string, ModelCandidate> = {
  "gemini-3.5-flash-lite": {
    id: "gemini-3.5-flash-lite",
    thinkingLevel: ThinkingLevel.MINIMAL,
    supportsJsonMode: true,
  },
  "gemini-3.1-flash-lite": {
    id: "gemini-3.1-flash-lite",
    thinkingLevel: ThinkingLevel.MINIMAL,
    supportsJsonMode: true,
  },
  "gemini-flash-lite-latest": {
    id: "gemini-flash-lite-latest",
    supportsJsonMode: true,
  },
  "gemma-4-31b-it": {
    id: "gemma-4-31b-it",
    supportsJsonMode: false,
  },
  "gemma-4-26b-a4b-it": {
    id: "gemma-4-26b-a4b-it",
    supportsJsonMode: false,
  },
  "gemini-flash-latest": {
    id: "gemini-flash-latest",
    supportsJsonMode: true,
  },
  "gemini-4-hydrogen": {
    id: "gemini-4-hydrogen",
    thinkingLevel: ThinkingLevel.LOW,
    supportsJsonMode: true,
  },
};

const FREE_PRIORITY_ORDER = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemma-4-31b-it",
  "gemini-flash-latest",
  "gemini-4-hydrogen",
];

const QUALITY_PRIORITY_ORDER = [
  "gemini-4-hydrogen",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemma-4-31b-it",
  "gemini-flash-lite-latest",
];

function isDisallowedModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (
    lower.startsWith("gemini-1.5") ||
    lower.startsWith("gemini-2.0") ||
    lower.startsWith("gemini-2.5") ||
    lower === "gemini-pro" ||
    lower.startsWith("gemini-1.0")
  ) {
    return true;
  }
  if (
    lower.includes("embedding") ||
    lower.includes("tts") ||
    lower.includes("image") ||
    lower.includes("imagen") ||
    lower.includes("veo") ||
    lower.includes("lyria") ||
    lower.includes("audio") ||
    lower.includes("live") ||
    lower.includes("aqa") ||
    lower.includes("transcribe") ||
    lower.includes("translate") ||
    lower.includes("decision") ||
    lower.includes("genie") ||
    lower.includes("robotics") ||
    lower.includes("computer-use") ||
    lower.includes("deep-research") ||
    lower.includes("nano-banana") ||
    lower.includes("omni") ||
    lower.includes("-pro") ||
    lower.includes("neon") ||
    lower.includes("carbon") ||
    lower.includes("argon")
  ) {
    return true;
  }
  return false;
}

function scoreDiscoveredModel(modelId: string, preferFree = true): number {
  const lower = modelId.toLowerCase();
  if (preferFree) {
    if (lower === "gemini-3.5-flash-lite") return 100;
    if (lower === "gemini-3.1-flash-lite") return 99;
    if (lower === "gemini-3.1-flash-lite-preview") return 98;
    if (lower === "gemini-flash-lite-latest") return 97;
    if (lower === "gemini-3.8-flash-lite") return 96;
    if (lower.includes("flash-lite") && !lower.startsWith("gemini-2.5")) return 95;
    if (lower === "gemma-4-31b-it") return 93;
    if (lower === "gemma-4-26b-a4b-it") return 92;
    if (lower.startsWith("gemma-4")) return 91;
    if (lower === "gemini-3-flash-preview") return 89;
    if (lower === "gemini-flash-latest") return 88;
    if (lower === "gemini-3.5-flash") return 86;
    if (lower === "gemini-3.8-flash") return 85;
    if (lower === "gemini-4-hydrogen") return 84;
    if (lower === "gemini-3.7-flash") return 83;
    if (lower === "gemini-3.6-flash") return 82;
    if (lower.includes("flash") && !lower.startsWith("gemini-2.5")) return 80;
    if (lower === "gemma-3-27b-it") return 76;
    if (lower === "gemma-3-12b-it") return 74;
    if (lower.startsWith("gemma-3") && !lower.includes("1b")) return 70;
    if (lower === "gemini-2.5-flash-lite") return 38;
    if (lower === "gemini-2.5-flash") return 35;
    return 10;
  }

  if (lower === "gemini-4-hydrogen") return 100;
  if (lower === "gemini-3.8-flash") return 98;
  if (lower === "gemini-3.7-flash") return 96;
  if (lower === "gemini-3.6-flash") return 95;
  if (lower === "gemini-3.5-flash") return 94;
  if (lower === "gemini-3-flash-preview") return 92;
  if (lower === "gemini-flash-latest") return 91;
  if (lower === "gemini-3.5-flash-lite") return 89;
  if (lower === "gemini-3.1-flash-lite") return 88;
  if (lower.startsWith("gemini-3.1-flash-lite")) return 87;
  if (lower === "gemini-flash-lite-latest") return 86;
  if (lower === "gemma-4-31b-it") return 84;
  if (lower === "gemma-4-26b-a4b-it") return 83;
  if (lower.startsWith("gemma-4")) return 82;
  if (lower.includes("flash") && !lower.startsWith("gemini-2.5")) return 80;
  if (lower === "gemma-3-27b-it") return 74;
  if (lower === "gemini-2.5-flash") return 40;
  if (lower === "gemini-2.5-flash-lite") return 38;
  return 10;
}

function getModelFamilyBucket(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gemma-")) return "gemma";
  if (lower.includes("flash-lite")) return "flash-lite";
  if (lower.includes("-latest")) return "latest";
  if (lower.startsWith("gemini-4")) return "gen4";
  return "flash";
}

function interleaveByFamily(models: ModelCandidate[]): ModelCandidate[] {
  const buckets = new Map<string, ModelCandidate[]>();
  for (const m of models) {
    const key = getModelFamilyBucket(m.id);
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }
  const result: ModelCandidate[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const list of buckets.values()) {
      const next = list.shift();
      if (next) {
        result.push(next);
        added = true;
      }
    }
  }
  return result;
}

async function discoverAvailableModelsForKey(
  apiKey: string,
  keyTag: string
): Promise<ModelCandidate[]> {
  const now = Date.now();
  const cached = discoveredModelsByKey.get(keyTag);
  if (cached && now < cached.expiresAt) {
    return cached.models;
  }

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      {
        headers: {
          "x-goog-api-key": apiKey,
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    };
    const found: ModelCandidate[] = [];
    for (const m of data.models ?? []) {
      const methods = m.supportedGenerationMethods ?? [];
      if (!methods.includes("generateContent")) continue;
      const id = (m.name || "").replace(/^models\//, "").trim();
      if (!id || isDisallowedModelId(id)) continue;
      const known = ALL_GEMINI_MODELS[id];
      if (known) {
        found.push(known);
      } else {
        const lower = id.toLowerCase();
        if (lower.startsWith("gemini-") || lower.startsWith("gemma-")) {
          found.push({
            id,
            thinkingLevel: inferDefaultThinkingLevel(id),
            supportsJsonMode: !lower.startsWith("gemma-"),
          });
        }
      }
    }
    found.sort((a, b) => scoreDiscoveredModel(b.id, true) - scoreDiscoveredModel(a.id, true));
    const top = found.slice(0, 16);
    discoveredModelsByKey.set(keyTag, {
      expiresAt: now + 10 * 60 * 1000,
      models: top,
    });
    return top;
  } catch {
    return [];
  }
}

const PERMANENT_SKIP_MS = 15 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 65 * 1000;
const BUSY_COOLDOWN_MS = 15 * 1000;

export function parseGeminiApiKeys(raw?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (typeof raw === "string" && raw.trim()) {
    const parts = raw
      .split(/[\r\n,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10);
    for (const k of parts) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out.slice(0, 20);
}

function getKeyTag(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 10);
}

export function maskApiKey(apiKey: string): string {
  const clean = apiKey.trim();
  if (clean.length <= 10) return "****";
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function resolveEffectiveKeyPool(rawUserKeys?: string): Array<{ key: string; tag: string; isServerDefault: boolean }> {
  const userKeys = parseGeminiApiKeys(rawUserKeys);
  if (userKeys.length > 0) {
    return userKeys.map((key) => ({ key, tag: getKeyTag(key), isServerDefault: false }));
  }
  const serverKey = (process.env.GEMINI_API_KEY || "").trim();
  if (serverKey) {
    return [{ key: serverKey, tag: "server-default", isServerDefault: true }];
  }
  return [];
}

function getOrderedKeyPool(rawUserKeys?: string): Array<{ key: string; tag: string; isServerDefault: boolean }> {
  const pool = resolveEffectiveKeyPool(rawUserKeys);
  if (pool.length <= 1) return pool;
  const start = roundRobinKeyCursor % pool.length;
  roundRobinKeyCursor = (roundRobinKeyCursor + 1) % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)];
}

export function getGeminiClient(customApiKey?: string): GoogleGenAI {
  const resolvedKey = (customApiKey || process.env.GEMINI_API_KEY || "").trim();
  const cacheKey = resolvedKey || "__default__";
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = new GoogleGenAI({
    apiKey: resolvedKey || undefined,
    httpOptions: {
      apiVersion: "v1beta",
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  if (clientCache.size > 40) {
    const firstKey = clientCache.keys().next().value;
    if (firstKey) clientCache.delete(firstKey);
  }
  clientCache.set(cacheKey, client);
  return client;
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

function isInvalidApiKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("API key not valid") ||
    msg.includes("API key expired") ||
    msg.includes("API_KEY_EXPIRED")
  );
}

function isModelConfigOrAccessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("NOT_FOUND") ||
    msg.includes("404") ||
    msg.includes("INVALID_ARGUMENT") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("403")
  );
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.toLowerCase().includes("quota") ||
    msg.toLowerCase().includes("rate limit")
  );
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

function getBaseModelOrder(mode?: GeminiModelMode): ModelCandidate[] {
  let ids: string[];
  if (mode === "auto_quality") {
    ids = [...QUALITY_PRIORITY_ORDER];
  } else if (mode && mode !== "auto_free" && ALL_GEMINI_MODELS[mode]) {
    ids = [mode, ...FREE_PRIORITY_ORDER.filter((id) => id !== mode)];
  } else {
    ids = [...FREE_PRIORITY_ORDER];
  }
  return ids.map((id) => ALL_GEMINI_MODELS[id]).filter(Boolean);
}

function getOrderedModelPoolForKey(
  keyTag: string,
  mode: GeminiModelMode | undefined,
  includeCooledDown: boolean
): ModelCandidate[] {
  const now = Date.now();
  const base = getBaseModelOrder(mode);

  // If user didn't pin a specific model, prioritize the last known healthy model for this key
  const isPinned = Boolean(mode && mode !== "auto_free" && mode !== "auto_quality");
  const lastHealthy = lastHealthyModelByKey.get(keyTag);
  if (!isPinned && lastHealthy) {
    const idx = base.findIndex((m) => m.id === lastHealthy);
    if (idx > 0) {
      const [healthy] = base.splice(idx, 1);
      base.unshift(healthy);
    }
  }

  const ready: ModelCandidate[] = [];
  const cooledBusy: ModelCandidate[] = [];

  for (const m of base) {
    const until = keyModelCooldownUntil.get(`${keyTag}:${m.id}`) ?? 0;
    if (now >= until) {
      ready.push(m);
    } else if (includeCooledDown && until - now <= Math.max(QUOTA_COOLDOWN_MS, BUSY_COOLDOWN_MS) + 5000) {
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
  keyTag: string,
  candidate: ModelCandidate,
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"],
  jsonMode: boolean,
  timeoutMs: number
): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  const cdKey = `${keyTag}:${candidate.id}`;
  const useJsonMime = jsonMode && candidate.supportsJsonMode !== false;
  const wantThinking =
    Boolean(candidate.thinkingLevel) && !modelsWithoutThinkingConfig.has(candidate.id);

  const runCall = (includeThinking: boolean) =>
    callGenerateContentWithTimeout(
      ai,
      {
        model: candidate.id,
        contents,
        config: {
          ...(useJsonMime ? { responseMimeType: "application/json" } : {}),
          ...(includeThinking && candidate.thinkingLevel
            ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
            : {}),
        },
      },
      timeoutMs
    );

  try {
    let response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
    try {
      response = await runCall(wantThinking);
    } catch (innerErr) {
      const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (wantThinking && innerMsg.includes("INVALID_ARGUMENT")) {
        modelsWithoutThinkingConfig.add(candidate.id);
        response = await runCall(false);
      } else {
        throw innerErr;
      }
    }

    keyModelCooldownUntil.delete(cdKey);
    lastHealthyModelByKey.set(keyTag, candidate.id);
    return response;
  } catch (err) {
    if (isInvalidApiKeyError(err)) {
      // Do not poison model cooldowns on other keys
      throw err;
    }
    if (isModelConfigOrAccessError(err)) {
      keyModelCooldownUntil.set(cdKey, Date.now() + PERMANENT_SKIP_MS);
      if (lastHealthyModelByKey.get(keyTag) === candidate.id) {
        lastHealthyModelByKey.delete(keyTag);
      }
    } else if (isQuotaError(err)) {
      keyModelCooldownUntil.set(cdKey, Date.now() + QUOTA_COOLDOWN_MS);
      if (lastHealthyModelByKey.get(keyTag) === candidate.id) {
        lastHealthyModelByKey.delete(keyTag);
      }
    } else if (isBusyOrTransientError(err)) {
      keyModelCooldownUntil.set(cdKey, Date.now() + BUSY_COOLDOWN_MS);
      if (lastHealthyModelByKey.get(keyTag) === candidate.id) {
        lastHealthyModelByKey.delete(keyTag);
      }
    }
    throw err;
  }
}

function raceCandidatesWithConcurrency(params: {
  ai: GoogleGenAI;
  keyTag: string;
  candidates: ModelCandidate[];
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"];
  jsonMode: boolean;
  concurrency: number;
  deadline: number;
  perModelTimeoutMs: number;
}): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  const {
    ai,
    keyTag,
    candidates,
    contents,
    jsonMode,
    concurrency,
    deadline,
    perModelTimeoutMs,
  } = params;

  return new Promise((resolve, reject) => {
    if (candidates.length === 0) {
      reject(new Error("503 UNAVAILABLE: هیچ مدل فعالی برای اجرا باقی نماند."));
      return;
    }

    let nextIndex = 0;
    let inFlight = 0;
    let settled = false;
    let sawInvalidKey = false;
    let lastError: unknown = null;

    const remainingTotal = Math.max(1000, deadline - Date.now());
    const deadlineTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          lastError instanceof Error
            ? lastError
            : new Error(`UPSTREAM_TIMEOUT_${remainingTotal}MS`)
        );
      }
    }, remainingTotal);

    const finishSuccess = (
      resp: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(resp);
    };

    const finishFailure = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(
        lastError instanceof Error
          ? lastError
          : new Error("503 UNAVAILABLE: امکان دریافت پاسخ از سرویس پردازش وجود نداشت.")
      );
    };

    const launchNext = () => {
      while (
        !settled &&
        !sawInvalidKey &&
        inFlight < concurrency &&
        nextIndex < candidates.length
      ) {
        const rem = deadline - Date.now();
        if (rem < 3500) break;

        const candidate = candidates[nextIndex++];
        inFlight++;
        const callTimeout = Math.min(perModelTimeoutMs, Math.max(4000, rem - 400));

        invokeCandidate(ai, keyTag, candidate, contents, jsonMode, callTimeout)
          .then((resp) => {
            inFlight--;
            finishSuccess(resp);
          })
          .catch((err) => {
            inFlight--;
            lastError = err;
            if (isInvalidApiKeyError(err)) {
              sawInvalidKey = true;
            }
            if (!settled) {
              if (!sawInvalidKey && nextIndex < candidates.length && deadline - Date.now() >= 3500) {
                launchNext();
              }
              if (inFlight === 0) {
                finishFailure();
              }
            }
          });
      }

      if (!settled && inFlight === 0) {
        finishFailure();
      }
    };

    launchNext();
  });
}

async function generateWithResilientModels(options: {
  rawApiKeys?: string;
  modelMode?: GeminiModelMode;
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"];
  jsonMode: boolean;
  timeoutMs: number;
  maxRounds?: number;
  totalBudgetMs?: number;
}): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
  const {
    rawApiKeys,
    modelMode,
    contents,
    jsonMode,
    timeoutMs,
    maxRounds = 2,
    totalBudgetMs = 45000,
  } = options;

  const keyPool = getOrderedKeyPool(rawApiKeys);
  if (keyPool.length === 0) {
    throw new Error("API_KEY_INVALID: هیچ کلید API فعالی یافت نشد. لطفاً کلید AI Studio رایگان خود را در تنظیمات وارد کنید.");
  }

  const deadline = Date.now() + totalBudgetMs;
  const invalidKeyTags = new Set<string>();
  const preferFree = modelMode !== "auto_quality";
  let lastError: unknown = null;

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() >= deadline - 1500) break;

    for (const keyEntry of keyPool) {
      if (invalidKeyTags.has(keyEntry.tag)) continue;
      if (Date.now() >= deadline - 2500) break;

      const ai = getGeminiClient(keyEntry.key);
      const baseCandidates = getOrderedModelPoolForKey(keyEntry.tag, modelMode, round > 0);
      const baseList =
        baseCandidates.length > 0
          ? baseCandidates
          : getOrderedModelPoolForKey(keyEntry.tag, modelMode, true);

      // Merge dynamically discovered models for this key, sorted for the selected mode
      const discoveredRaw = await discoverAvailableModelsForKey(keyEntry.key, keyEntry.tag);
      const discovered = [...discoveredRaw].sort(
        (a, b) => scoreDiscoveredModel(b.id, preferFree) - scoreDiscoveredModel(a.id, preferFree)
      );
      const now = Date.now();
      const mergedMap = new Map<string, ModelCandidate>();

      const lastHealthyId = lastHealthyModelByKey.get(keyEntry.tag);
      const isPinned = Boolean(modelMode && modelMode !== "auto_free" && modelMode !== "auto_quality");
      if (!isPinned && lastHealthyId) {
        const match =
          discovered.find((m) => m.id === lastHealthyId) ||
          baseList.find((m) => m.id === lastHealthyId);
        if (match && (round > 0 || now >= (keyModelCooldownUntil.get(`${keyEntry.tag}:${match.id}`) ?? 0))) {
          mergedMap.set(match.id, match);
        }
      }

      if (isPinned) {
        for (const m of baseList) mergedMap.set(m.id, m);
        for (const m of discovered) {
          if (!mergedMap.has(m.id) && (round > 0 || now >= (keyModelCooldownUntil.get(`${keyEntry.tag}:${m.id}`) ?? 0))) {
            mergedMap.set(m.id, m);
          }
        }
      } else {
        for (const m of discovered) {
          if (!mergedMap.has(m.id) && (round > 0 || now >= (keyModelCooldownUntil.get(`${keyEntry.tag}:${m.id}`) ?? 0))) {
            mergedMap.set(m.id, m);
          }
        }
        for (const m of baseList) {
          if (!mergedMap.has(m.id)) mergedMap.set(m.id, m);
        }
      }

      const listToTry = Array.from(mergedMap.values());
      if (listToTry.length === 0) continue;

      // 1) Try the primary / last-known-healthy model first (single call to conserve free quota)
      const primary = listToTry[0];
      const primaryRem = deadline - Date.now();
      if (primary && primaryRem >= 4000) {
        try {
          return await invokeCandidate(
            ai,
            keyEntry.tag,
            primary,
            contents,
            jsonMode,
            Math.min(Math.max(timeoutMs, 24000), primaryRem - 500)
          );
        } catch (err) {
          lastError = err;
          if (isInvalidApiKeyError(err)) {
            invalidKeyTags.add(keyEntry.tag);
            continue;
          }
          if (
            !isModelConfigOrAccessError(err) &&
            !isQuotaError(err) &&
            !isBusyOrTransientError(err)
          ) {
            throw err;
          }
        }
      }

      // 2) Primary failed (503/429/404/timeout): run a sliding concurrency pool across diverse model families.
      // Fast 503/404/429 errors immediately refill their slot; accepted generating models get up to 38s to complete.
      const remaining = interleaveByFamily(listToTry.slice(1));
      if (remaining.length > 0 && deadline - Date.now() >= 4000) {
        const keyShareDeadline =
          keyPool.length > 1
            ? Math.min(deadline, Date.now() + Math.max(18000, Math.floor((deadline - Date.now()) / 2)))
            : deadline;
        try {
          return await raceCandidatesWithConcurrency({
            ai,
            keyTag: keyEntry.tag,
            candidates: remaining,
            contents,
            jsonMode,
            concurrency: 4,
            deadline: keyShareDeadline,
            perModelTimeoutMs: Math.max(timeoutMs, 38000),
          });
        } catch (err) {
          lastError = err;
          if (isInvalidApiKeyError(err)) {
            invalidKeyTags.add(keyEntry.tag);
          }
        }
      }
    }

    if (invalidKeyTags.size >= keyPool.length) break;

    if (round < maxRounds - 1 && deadline - Date.now() > 6000) {
      const backoffMs = 500 + Math.floor(Math.random() * 300);
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("503 UNAVAILABLE: امکان دریافت پاسخ از سرویس پردازش وجود نداشت.");
}

export interface KeyTestResult {
  maskedKey: string;
  isServerDefault: boolean;
  ok: boolean;
  workingModel?: string;
  availableModels?: string[];
  error?: string;
  detail?: string;
}

function summarizeRawError(msg: string): string {
  const codeMatch = msg.match(/"code"\s*:\s*(\d+)/) || msg.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
  const statusMatch = msg.match(/"status"\s*:\s*"([^"]+)"/);
  const messageMatch = msg.match(/"message"\s*:\s*"([^"]+)"/);
  const parts = [codeMatch?.[1], statusMatch?.[1], messageMatch?.[1]].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ").slice(0, 140) : msg.slice(0, 140);
}

export async function testGeminiKeys(
  rawApiKeys?: string,
  modelMode?: GeminiModelMode
): Promise<KeyTestResult[]> {
  const pool = resolveEffectiveKeyPool(rawApiKeys);
  if (pool.length === 0) {
    return [
      {
        maskedKey: "بدون کلید",
        isServerDefault: true,
        ok: false,
        error: "هیچ کلیدی وارد نشده است.",
      },
    ];
  }

  const baseModels = getBaseModelOrder(modelMode);
  const results = await Promise.all(
    pool.map(async (entry): Promise<KeyTestResult> => {
      const ai = getGeminiClient(entry.key);
      const discovered = await discoverAvailableModelsForKey(entry.key, entry.tag);
      const mergedMap = new Map<string, ModelCandidate>();
      for (const m of discovered) mergedMap.set(m.id, m);
      for (const m of baseModels) {
        if (!mergedMap.has(m.id)) mergedMap.set(m.id, m);
      }
      const models = Array.from(mergedMap.values()).slice(0, 16);

      // Probe all discovered models concurrently and resolve as soon as the FIRST healthy model responds!
      const errorNotes: string[] = [];
      let sawInvalidKey = false;
      let invalidDetail = "";
      let sawQuota = false;
      let sawBusy = false;
      let sawForbidden = false;

      const probePromises = models.map(async (candidate) => {
        const useJsonMime = candidate.supportsJsonMode !== false;
        try {
          await callGenerateContentWithTimeout(
            ai,
            {
              model: candidate.id,
              contents: 'Return JSON: {"ok":true}',
              config: {
                ...(useJsonMime ? { responseMimeType: "application/json" } : {}),
                ...(candidate.thinkingLevel
                  ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
                  : {}),
              },
            },
            15000
          );
          return candidate;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errorNotes.push(`${candidate.id}: ${summarizeRawError(msg)}`);
          if (isInvalidApiKeyError(err)) {
            sawInvalidKey = true;
            invalidDetail = summarizeRawError(msg);
          } else if (isModelConfigOrAccessError(err)) {
            keyModelCooldownUntil.set(`${entry.tag}:${candidate.id}`, Date.now() + PERMANENT_SKIP_MS);
          }
          if (isQuotaError(err)) sawQuota = true;
          else if (isBusyOrTransientError(err)) sawBusy = true;
          else if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) sawForbidden = true;
          throw err;
        }
      });

      try {
        const winner = await Promise.any(probePromises);
        keyModelCooldownUntil.delete(`${entry.tag}:${winner.id}`);
        lastHealthyModelByKey.set(entry.tag, winner.id);
        return {
          maskedKey: entry.isServerDefault ? "کلید پیش‌فرض سرور" : maskApiKey(entry.key),
          isServerDefault: entry.isServerDefault,
          ok: true,
          workingModel: winner.id,
          availableModels: discovered.map((d) => d.id),
        };
      } catch {
        // All probes rejected
      }

      if (sawInvalidKey) {
        return {
          maskedKey: entry.isServerDefault ? "کلید پیش‌فرض سرور" : maskApiKey(entry.key),
          isServerDefault: entry.isServerDefault,
          ok: false,
          error: "کلید نامعتبر یا منقضی شده است.",
          detail: invalidDetail,
        };
      }

      console.warn(`[TestKey Failed] ${entry.tag}:`, errorNotes.join(" | "));

      const friendly = sawQuota
        ? "سهمیه رایگان این کلید موقتاً پر شده است (429)."
        : sawForbidden
          ? "کلید دسترسی به مدل‌ها ندارد یا محدودیت منطقه‌ای/پروژه دارد (403)."
          : sawBusy
            ? "همه مدل‌های این کلید موقتاً شلوغ هستند (503). چند لحظه بعد دوباره تست کنید."
            : "هیچ مدل فعالی با این کلید پاسخ نداد.";
      return {
        maskedKey: entry.isServerDefault ? "کلید پیش‌فرض سرور" : maskApiKey(entry.key),
        isServerDefault: entry.isServerDefault,
        ok: false,
        availableModels: discovered.map((d) => d.id),
        error: friendly,
        detail: errorNotes.slice(0, 5).join(" | "),
      };
    })
  );

  return results;
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

  const hasGeminiKeyPool = getOrderedKeyPool(settings.geminiApiKey).length > 0;
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
    const useFreeTierSaver = settings.freeTierSaver !== false;
    if (useFreeTierSaver || Date.now() < searchToolBlockedUntil) return false;

    const keyPool = getOrderedKeyPool(settings.geminiApiKey);
    const firstKey = keyPool[0];
    if (!firstKey) return false;

    const ai = getGeminiClient(firstKey.key);
    const searchModels = getOrderedModelPoolForKey(
      firstKey.tag,
      settings.geminiModelMode,
      false
    ).slice(0, 2);

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
              ...(candidate.thinkingLevel
                ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
                : {}),
            },
          },
          14000
        );
        parsedBox.value = extractJsonObject(candidateResp.text ?? "");
        responseBox.value = candidateResp;
        keyModelCooldownUntil.delete(`${firstKey.tag}:${candidate.id}`);
        lastHealthyModelByKey.set(firstKey.tag, candidate.id);
        return true;
      } catch (err) {
        lastError = err;
        if (isInvalidApiKeyError(err)) break;
        if (isQuotaError(err)) {
          searchToolBlockedUntil = Date.now() + 15 * 60 * 1000;
          break;
        }
        if (isModelConfigOrAccessError(err)) {
          keyModelCooldownUntil.set(
            `${firstKey.tag}:${candidate.id}`,
            Date.now() + PERMANENT_SKIP_MS
          );
          continue;
        }
        if (isBusyOrTransientError(err)) {
          keyModelCooldownUntil.set(
            `${firstKey.tag}:${candidate.id}`,
            Date.now() + BUSY_COOLDOWN_MS
          );
          continue;
        }
        break;
      }
    }
    return false;
  };

  const tryGeminiStructuredJson = async (): Promise<boolean> => {
    const context = await ensureFallbackContext();
    const contents = buildContents(buildPrompt(context.contextSummary));

    for (let parseTry = 0; parseTry < 2; parseTry++) {
      try {
        const candidateResp = await generateWithResilientModels({
          rawApiKeys: settings.geminiApiKey,
          modelMode: settings.geminiModelMode,
          contents,
          jsonMode: true,
          timeoutMs: 36000,
          maxRounds: 2,
          totalBudgetMs: 46000,
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
    if (!hasGeminiKeyPool) return false;
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
  const response = responseBox.value;
  const fallbackContext = contextBox.value;

  const groundingMeta = response?.candidates?.[0]?.groundingMetadata;
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
  apiKey?: string,
  freeTierSaver = true
): Promise<string[]> {
  const urls = new Set<string>();

  if (!freeTierSaver && Date.now() >= searchToolBlockedUntil) {
    const keyPool = getOrderedKeyPool(apiKey);
    const firstKey = keyPool[0];
    if (firstKey) {
      const ai = getGeminiClient(firstKey.key);
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

      const modelsToTry = getOrderedModelPoolForKey(firstKey.tag, "auto_free", false).slice(0, 2);
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
                ...(candidate.thinkingLevel
                  ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
                  : {}),
              },
            },
            14000
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
          if (isInvalidApiKeyError(err)) break;
        }
      }
    }
  }

  // Always use fast, free live web search pages if empty or in Free Tier Saver mode
  if (urls.size === 0) {
    const live = await fetchLiveWebContextFallback(brand ? `${brand} ${productName}` : productName);
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
  const hasGeminiKeyPool = getOrderedKeyPool(params.settings?.geminiApiKey).length > 0;
  const canUseExternal = Boolean(
    activeCustomProvider || params.settings?.autoFreeFallback !== false
  );
  const isImageInput = params.mimeType.startsWith("image/");

  if (!isImageInput && !hasGeminiKeyPool) {
    throw new Error(
      "خواندن مستقیم فایل PDF فقط با کلید Gemini امکان‌پذیر است. لطفاً کلید Gemini را در تنظیمات وارد کنید یا فایل را به‌صورت عکس (JPG/PNG) ارسال کنید."
    );
  }

  let rawText: string | null = null;

  if (hasGeminiKeyPool) {
    try {
      const response = await generateWithResilientModels({
        rawApiKeys: params.settings?.geminiApiKey,
        modelMode: params.settings?.geminiModelMode,
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
        timeoutMs: 32000,
        maxRounds: 2,
        totalBudgetMs: 44000,
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
