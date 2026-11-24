import net from "node:net";
import type { CustomProviderProfile, EnrichmentSettings } from "../src/types/product.ts";

const DEFAULT_BASE_URLS: Record<CustomProviderProfile["type"], string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  custom: "",
};

const ENV_KEY_NAMES: Record<CustomProviderProfile["type"], string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  custom: "CUSTOM_AI_API_KEY",
};

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

function resolveProviderServerKey(type: CustomProviderProfile["type"]): string {
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
  }
}

export async function generateJsonWithExternalProvider(params: {
  provider: CustomProviderProfile;
  prompt: string;
  imageBase64?: string | null;
  imageMimeType?: string;
  timeoutMs?: number;
}): Promise<string> {
  const { provider, prompt, imageBase64, imageMimeType = "image/webp", timeoutMs = 45000 } = params;

  const rawBaseUrl = provider.baseUrl?.trim() || DEFAULT_BASE_URLS[provider.type];
  if (!rawBaseUrl) {
    throw new Error(`آدرس Base URL برای ارائه‌دهنده «${provider.name}» مشخص نشده است.`);
  }

  const baseUrl = validateExternalProviderBaseUrl(rawBaseUrl);
  const model = provider.model?.trim();
  if (!model) {
    throw new Error(`نام مدل برای ارائه‌دهنده «${provider.name}» مشخص نشده است.`);
  }

  const apiKey = (provider.apiKey || "").trim() || resolveProviderServerKey(provider.type);
  if (!apiKey) {
    const envVarName = ENV_KEY_NAMES[provider.type];
    throw new Error(
      `کلید API برای ارائه‌دهنده «${provider.name}» وارد نشده است. لطفاً کلید خود را در بخش تنظیمات همین ارائه‌دهنده وارد کنید (یا متغیر ${envVarName} را روی سرور تنظیم کنید).`
    );
  }

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
    Authorization: `Bearer ${apiKey}`,
    ...(provider.type === "openrouter"
      ? {
          "HTTP-Referer": process.env.APP_URL || "https://kalasaz.app",
          "X-Title": "Kalasaz",
        }
      : {}),
  };

  const runRequest = async (useJsonFormat: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
      ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawText = await res.text();
    if (!res.ok) {
      const snippet = rawText.slice(0, 300);
      if (res.status === 400 && useJsonFormat && snippet.toLowerCase().includes("response_format")) {
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `خطای احراز هویت (${res.status}) از ارائه‌دهنده «${provider.name}». متغیر محیطی ${ENV_KEY_NAMES[provider.type]} را روی سرور بررسی کنید.`
        );
      }
      if (res.status === 429) {
        throw new Error(`429 RESOURCE_EXHAUSTED از ارائه‌دهنده «${provider.name}»: ${snippet}`);
      }
      if (res.status >= 500) {
        throw new Error(`503 UNAVAILABLE از ارائه‌دهنده «${provider.name}»: ${snippet}`);
      }
      throw new Error(`خطا از ارائه‌دهنده «${provider.name}» (${res.status}): ${snippet}`);
    }

    const data = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
    }
    throw new Error(`پاسخ متنی معتبری از ارائه‌دهنده «${provider.name}» دریافت نشد.`);
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const first = await runRequest(true);
      if (first !== null) return first;
      const fallbackNoJsonFmt = await runRequest(false);
      if (fallbackNoJsonFmt !== null) return fallbackNoJsonFmt;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && (msg.includes("503") || msg.includes("429") || msg.includes("Timeout"))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`امکان دریافت پاسخ از ارائه‌دهنده «${provider.name}» وجود نداشت.`);
}
