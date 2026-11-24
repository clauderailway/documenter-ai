import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import {
  extractProductListFromScan,
  findMoreProductPagesWithGemini,
  researchProductWithGemini,
  testGeminiKeys,
} from "./server/gemini.ts";
import {
  collectWebpImagesForProduct,
  convertImageBufferToWebp,
  downloadAndConvertImageToWebp,
  ensureWebpCacheDir,
  getWebpFilePath,
  readWebpAsBase64,
  scrapeImagesFromPage,
} from "./server/imagePipeline.ts";
import {
  DEFAULT_SETTINGS,
  type EnrichedProduct,
  type EnrichmentSettings,
  type WebpImageAsset,
} from "./src/types/product.ts";

// Hosting platforms assign the port; names differ per provider:
// Altare uses SERVER_PORT, most PaaS use PORT.
const PORT = Number(
  process.env.PORT ||
    process.env.SERVER_PORT ||
    process.env.APP_PORT ||
    3000
);

function sanitizeSettings(input: Partial<EnrichmentSettings> | undefined): EnrichmentSettings {
  const validTypes = new Set(["openrouter", "openai", "groq", "custom", "pollinations"]);
  const validGeminiModes = new Set([
    "auto_free",
    "auto_quality",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
  ]);
  const rawProviders = Array.isArray(input?.customProviders) ? input.customProviders : [];
  const customProviders = rawProviders
    .slice(0, 20)
    .filter((p): p is EnrichmentSettings["customProviders"][number] => Boolean(p && typeof p === "object"))
    .map((p) => ({
      id: typeof p.id === "string" ? p.id.slice(0, 64) : "",
      name: typeof p.name === "string" ? p.name.trim().slice(0, 80) : "",
      type: (validTypes.has(p.type) ? p.type : "custom") as EnrichmentSettings["customProviders"][number]["type"],
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl.trim().slice(0, 300) : "",
      model: typeof p.model === "string" ? p.model.trim().slice(0, 120) : "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey.trim().slice(0, 300) : "",
    }))
    .filter((p) => p.id && p.name && p.model);

  const rawModelMode = typeof input?.geminiModelMode === "string" ? input.geminiModelMode.trim() : "";

  return {
    domainProfile: input?.domainProfile ?? DEFAULT_SETTINGS.domainProfile,
    storeName: typeof input?.storeName === "string" ? input.storeName : DEFAULT_SETTINGS.storeName,
    wpImageBaseUrl:
      typeof input?.wpImageBaseUrl === "string"
        ? input.wpImageBaseUrl
        : DEFAULT_SETTINGS.wpImageBaseUrl,
    outputLanguage: input?.outputLanguage ?? DEFAULT_SETTINGS.outputLanguage,
    tone: input?.tone ?? DEFAULT_SETTINGS.tone,
    longDescFormat: input?.longDescFormat ?? DEFAULT_SETTINGS.longDescFormat,
    webpMaxWidth: Number(input?.webpMaxWidth) || DEFAULT_SETTINGS.webpMaxWidth,
    webpQuality: Number(input?.webpQuality) || DEFAULT_SETTINGS.webpQuality,
    webpFitMode: input?.webpFitMode ?? DEFAULT_SETTINGS.webpFitMode,
    targetImageCount: Number(input?.targetImageCount) || DEFAULT_SETTINGS.targetImageCount,
    aiProviderId:
      typeof input?.aiProviderId === "string" && input.aiProviderId.trim()
        ? input.aiProviderId.trim().slice(0, 64)
        : DEFAULT_SETTINGS.aiProviderId,
    customProviders,
    geminiApiKey: typeof input?.geminiApiKey === "string" ? input.geminiApiKey.trim().slice(0, 4000) : "",
    geminiModelMode: (validGeminiModes.has(rawModelMode)
      ? rawModelMode
      : DEFAULT_SETTINGS.geminiModelMode) as EnrichmentSettings["geminiModelMode"],
    freeTierSaver: input?.freeTierSaver !== false,
    openrouterApiKey:
      typeof input?.openrouterApiKey === "string" ? input.openrouterApiKey.trim().slice(0, 200) : "",
    groqApiKey: typeof input?.groqApiKey === "string" ? input.groqApiKey.trim().slice(0, 200) : "",
    autoFreeFallback: input?.autoFreeFallback !== false,
  };
}

function csvEscape(value: string): string {
  const safe = (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (safe.includes('"') || safe.includes(",") || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function formatErrorMessage(err: unknown): { status: number; message: string; detail?: string } {
  console.error("[API Error]", err);
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("API key not valid") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("403")
  ) {
    return {
      status: 403,
      message:
        "کلید API معتبر نیست یا دسترسی ندارد. کلیدهای Gemini / OpenRouter / Groq را در بخش «تنظیمات و پروایدرها» بررسی کنید.",
      detail: msg,
    };
  }
  if (
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("quota") ||
    msg.includes("429") ||
    msg.includes("402") ||
    msg.includes("FREE_LIMIT")
  ) {
    return {
      status: 429,
      message:
        "سهمیه درخواست مدل‌های رایگان این لحظه پر شده است. سیستم به‌طور خودکار کلیدها، مدل‌های رایگان و سرویس‌های دیگر را امتحان می‌کند؛ چند لحظه بعد دوباره تلاش کنید یا کلید رایگان OpenRouter/Groq را در تنظیمات اضافه کنید.",
      detail: msg,
    };
  }
  if (
    msg.includes("503") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("UPSTREAM_TIMEOUT")
  ) {
    return {
      status: 503,
      message:
        "همه مدل‌های رایگان در این لحظه شلوغ هستند (خطای 503 از سمت سرور مدل). چند لحظه بعد دوباره امتحان کنید — سیستم به‌صورت خودکار بین کلیدها، مدل‌ها و سرویس‌های رایگان جابه‌جا می‌شود.",
      detail: msg,
    };
  }
  if (
    msg.includes("هیچ سرویس هوش مصنوعی") ||
    msg.includes("سرویس بینایی") ||
    msg.includes("کلید رایگان") ||
    msg.includes("کلید Gemini")
  ) {
    return {
      status: 400,
      message: msg,
      detail: msg,
    };
  }
  return {
    status: 500,
    message: msg || "خطا در پردازش اطلاعات محصول",
    detail: msg,
  };
}

async function startServer() {
  ensureWebpCacheDir();
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/ai/test-keys", async (req, res) => {
    try {
      const settings = sanitizeSettings(req.body?.settings);
      const results = await testGeminiKeys(settings.geminiApiKey, settings.geminiModelMode);
      res.json({ results });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.get("/api/webp/:filename", (req, res) => {
    const rawName = req.params.filename.replace(/\.webp$/i, "");
    const filePath = getWebpFilePath(rawName);
    if (!filePath) {
      res.status(404).send("Not found");
      return;
    }

    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    if (req.query.download === "1") {
      const requestedName =
        typeof req.query.name === "string" && req.query.name.trim()
          ? req.query.name.replace(/[^a-zA-Z0-9._-]/g, "-")
          : `${rawName}.webp`;
      const finalName = requestedName.endsWith(".webp") ? requestedName : `${requestedName}.webp`;
      res.setHeader("Content-Disposition", `attachment; filename="${finalName}"`);
    }

    fs.createReadStream(filePath).pipe(res);
  });

  // Main product enrichment endpoint (supports text query, seedUrl, and seedImage multimodal)
  app.post("/api/products/enrich", async (req, res) => {
    try {
      const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
      const seedUrl = typeof req.body?.seedUrl === "string" ? req.body.seedUrl.trim() : "";
      const incomingSeedImage = req.body?.seedImage as WebpImageAsset | undefined;

      if (!query && !seedUrl && !incomingSeedImage) {
        res.status(400).json({ error: "نام کالا، لینک یا تصویر نمی‌تواند خالی باشد." });
        return;
      }

      const settings = sanitizeSettings(req.body?.settings);
      const seedImagesFromInput: WebpImageAsset[] = [];

      if (incomingSeedImage?.id) {
        seedImagesFromInput.push({
          ...incomingSeedImage,
          selected: true,
          isPrimary: true,
        });
      } else if (seedUrl && (seedUrl.startsWith("http://") || seedUrl.startsWith("https://"))) {
        // Try seedUrl as direct image first
        const directAsset = await downloadAndConvertImageToWebp(
          seedUrl,
          seedUrl,
          settings,
          true
        );
        if (directAsset) {
          seedImagesFromInput.push(directAsset);
        } else {
          // Try seedUrl as product page and grab up to 3 top images
          const candidates = await scrapeImagesFromPage(seedUrl);
          for (const c of candidates.slice(0, 6)) {
            const converted = await downloadAndConvertImageToWebp(
              c.imageUrl,
              c.pageUrl,
              settings,
              seedImagesFromInput.length === 0
            );
            if (converted) {
              seedImagesFromInput.push(converted);
              if (seedImagesFromInput.length >= 3) break;
            }
          }
        }
      }

      // Read primary seed image as base64 so Gemini Vision can identify the exact product
      let seedImageBase64: string | null = null;
      if (seedImagesFromInput[0]?.id) {
        seedImageBase64 = await readWebpAsBase64(seedImagesFromInput[0].id);
      }

      const effectiveQuery = query || (seedUrl ? `محصول موجود در لینک ${seedUrl}` : "شناسایی کالا از روی تصویر");
      const research = await researchProductWithGemini(effectiveQuery, settings, {
        seedImageBase64,
        seedUrl: seedUrl || undefined,
      });

      const pageUrls = [
        ...(seedUrl ? [seedUrl] : []),
        ...research.candidatePageUrls,
        ...research.sources.map((s) => s.url),
      ];

      const remainingImageSlots = Math.max(0, settings.targetImageCount - seedImagesFromInput.length);
      let webImages: WebpImageAsset[] = [];

      if (remainingImageSlots > 0) {
        webImages = await collectWebpImagesForProduct({
          pageUrls,
          directImageUrls: research.directImageUrls,
          query: effectiveQuery,
          titleEn: research.titleEn,
          settings: {
            ...settings,
            targetImageCount: remainingImageSlots,
          },
        });

        if (seedImagesFromInput.length + webImages.length < 2) {
          const extraPages = await findMoreProductPagesWithGemini(
            research.titleEn || effectiveQuery,
            research.brand,
            settings.domainProfile === "medical",
            settings.geminiApiKey,
            settings.freeTierSaver
          );
          const existingSet = new Set(pageUrls);
          const freshPages = extraPages.filter((u) => !existingSet.has(u));
          if (freshPages.length > 0) {
            const extraImages = await collectWebpImagesForProduct({
              pageUrls: freshPages,
              directImageUrls: [],
              query: effectiveQuery,
              titleEn: research.titleEn,
              settings: {
                ...settings,
                targetImageCount: Math.max(
                  1,
                  settings.targetImageCount - seedImagesFromInput.length - webImages.length
                ),
              },
            });
            webImages.push(...extraImages);
          }
        }
      }

      // Combine seed images first (deduping sourceUrl) + web-discovered images
      const seenSourceUrls = new Set(seedImagesFromInput.map((i) => i.sourceUrl));
      const combinedImages: WebpImageAsset[] = [...seedImagesFromInput];
      for (const img of webImages) {
        if (seenSourceUrls.has(img.sourceUrl)) continue;
        seenSourceUrls.add(img.sourceUrl);
        combinedImages.push({
          ...img,
          isPrimary: combinedImages.length === 0,
        });
      }

      res.json({
        titleFa: research.titleFa,
        titleEn: research.titleEn,
        slug: research.slug,
        brand: research.brand,
        category: research.category,
        modelCode: research.modelCode,
        shortDescription: research.shortDescription,
        longDescription: research.longDescription,
        longDescriptionHtml: research.longDescriptionHtml,
        specs: research.specs,
        images: combinedImages,
        sources: research.sources,
        searchQueries: research.searchQueries,
      });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/products/more-images", async (req, res) => {
    try {
      const productName = typeof req.body?.productName === "string" ? req.body.productName.trim() : "";
      const brand = typeof req.body?.brand === "string" ? req.body.brand.trim() : "";
      const settings = sanitizeSettings(req.body?.settings);

      if (!productName) {
        res.status(400).json({ error: "نام محصول مشخص نیست." });
        return;
      }

      const pages = await findMoreProductPagesWithGemini(
        productName,
        brand,
        settings.domainProfile === "medical",
        settings.geminiApiKey,
        settings.freeTierSaver
      );
      const images = await collectWebpImagesForProduct({
        pageUrls: pages,
        directImageUrls: [],
        query: productName,
        titleEn: productName,
        settings,
      });

      res.json({ images, pages });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/images/from-url", async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const settings = sanitizeSettings(req.body?.settings);

      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        res.status(400).json({ error: "لطفاً یک لینک معتبر با http یا https وارد کنید." });
        return;
      }

      const direct = await downloadAndConvertImageToWebp(url, url, settings, false);
      if (direct) {
        res.json({ images: [direct] });
        return;
      }

      const candidates = await scrapeImagesFromPage(url);
      const converted: WebpImageAsset[] = [];
      for (const c of candidates.slice(0, 10)) {
        const asset = await downloadAndConvertImageToWebp(
          c.imageUrl,
          c.pageUrl,
          settings,
          false
        );
        if (asset) {
          converted.push(asset);
          if (converted.length >= 6) break;
        }
      }

      if (converted.length === 0) {
        res.status(422).json({
          error: "تصویر قابل استفاده‌ای از این لینک استخراج نشد یا سایت مبدا دسترسی را مسدود کرده است.",
        });
        return;
      }

      res.json({ images: converted });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/images/upload", async (req, res) => {
    try {
      const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
      const filename = typeof req.body?.filename === "string" ? req.body.filename : "upload";
      const settings = sanitizeSettings(req.body?.settings);

      const match = dataUrl.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
      if (!match) {
        res.status(400).json({ error: "فرمت تصویر ارسالی معتبر نیست." });
        return;
      }

      const buffer = Buffer.from(match[1], "base64");
      const asset = await convertImageBufferToWebp(
        buffer,
        filename,
        "https://local-upload",
        settings,
        false
      );

      if (!asset) {
        res.status(422).json({ error: "امکان تبدیل این تصویر به WebP وجود نداشت (حداقل ابعاد ۲۲۰×۲۲۰)." });
        return;
      }

      res.json({ image: asset });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.get("/api/proxy-image", async (req, res) => {
    try {
      const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        res.status(400).send("Invalid URL");
        return;
      }
      const upstream = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(7000),
      });
      if (!upstream.ok) {
        res.status(404).send("Not found");
        return;
      }
      const contentType = upstream.headers.get("content-type") || "image/png";
      if (!contentType.toLowerCase().startsWith("image/")) {
        res.status(415).send("Unsupported media type");
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(buf);
    } catch {
      res.status(502).send("Proxy error");
    }
  });

  app.post("/api/images/edit", async (req, res) => {
    try {
      const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
      const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl : "";
      const sourceDomain =
        typeof req.body?.sourceDomain === "string" && req.body.sourceDomain.trim()
          ? req.body.sourceDomain.trim()
          : "edited";
      const isPrimary = Boolean(req.body?.isPrimary);
      const selected = req.body?.selected !== false;
      const fitMode = req.body?.fitMode === "contain_white" ? "contain_white" : "inside";
      const settings = sanitizeSettings(req.body?.settings);

      const match = dataUrl.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
      if (!match) {
        res.status(400).json({ error: "فرمت تصویر ویرایش‌شده معتبر نیست." });
        return;
      }

      const rawBuffer = Buffer.from(match[1], "base64");
      const maxDim = Math.min(Math.max(settings.webpMaxWidth || 1000, 400), 2000);
      const quality = Math.min(Math.max(settings.webpQuality || 85, 40), 100);

      let pipeline = sharp(rawBuffer, { failOn: "none" });
      if (fitMode === "contain_white") {
        pipeline = pipeline
          .resize({
            width: maxDim,
            height: maxDim,
            fit: "contain",
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .flatten({ background: { r: 255, g: 255, b: 255 } });
      } else {
        pipeline = pipeline.resize({
          width: maxDim,
          height: maxDim,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const webpBuffer = await pipeline.webp({ quality, effort: 4 }).toBuffer();
      const outMeta = await sharp(webpBuffer).metadata();

      const newId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const filePath = path.join(ensureWebpCacheDir(), `${newId}.webp`);
      await fs.promises.writeFile(filePath, webpBuffer);

      const asset: WebpImageAsset = {
        id: newId,
        url: `/api/webp/${newId}.webp`,
        sourceUrl: sourceUrl || "edited-canvas",
        sourceDomain,
        width: outMeta.width ?? 0,
        height: outMeta.height ?? 0,
        sizeBytes: webpBuffer.length,
        selected,
        isPrimary,
      };

      res.json({ image: asset });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  // Extract product list from scanned A4 paper (image or PDF)
  app.post("/api/scan/extract-list", async (req, res) => {
    try {
      const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
      const isMedical = req.body?.domainProfile !== "general";

      const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);
      if (!match) {
        res.status(400).json({ error: "فایل ارسالی معتبر نیست (عکس یا PDF انتخاب کنید)." });
        return;
      }

      const rawMime = match[1].toLowerCase();
      const rawBuffer = Buffer.from(match[2], "base64");

      let finalBase64 = match[2];
      let finalMime = rawMime;

      if (rawMime.startsWith("image/")) {
        // Normalize orientation & keep crisp resolution for small Persian/English print on A4
        const optimized = await sharp(rawBuffer, { failOn: "none" })
          .rotate()
          .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();
        finalBase64 = optimized.toString("base64");
        finalMime = "image/jpeg";
      } else if (rawMime !== "application/pdf") {
        res.status(400).json({ error: "فقط تصاویر (JPG/PNG/WebP) یا فایل PDF پشتیبانی می‌شود." });
        return;
      }

      const settings = sanitizeSettings(req.body?.settings);
      const result = await extractProductListFromScan({
        base64Data: finalBase64,
        mimeType: finalMime,
        isMedical,
        settings,
      });

      res.json(result);
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  type ExportableWebpImage = WebpImageAsset & { dataUrl?: string };

  async function resolveWebpBufferForExport(
    img: ExportableWebpImage,
    settings: EnrichmentSettings,
    productReferer?: string
  ): Promise<Buffer | null> {
    const safeId = (img.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const existingPath = safeId ? getWebpFilePath(safeId) : null;
    if (existingPath) {
      try {
        return await fs.promises.readFile(existingPath);
      } catch {
        // continue to restore below
      }
    }

    const persistToCache = async (webpBuf: Buffer) => {
      if (!safeId) return;
      try {
        const destPath = path.join(ensureWebpCacheDir(), `${safeId}.webp`);
        await fs.promises.writeFile(destPath, webpBuf);
      } catch {
        // ignore cache write failure
      }
    };

    const inlineData =
      typeof img.dataUrl === "string" && img.dataUrl.trim()
        ? img.dataUrl.trim()
        : typeof img.url === "string" && img.url.startsWith("data:image/")
          ? img.url
          : "";

    if (inlineData) {
      const b64Match = inlineData.match(/^(?:data:image\/[a-zA-Z0-9+.-]+;base64,)?(.+)$/);
      if (b64Match) {
        try {
          const rawBuf = Buffer.from(b64Match[1], "base64");
          const maxDim = Math.min(Math.max(settings.webpMaxWidth || 1000, 400), 2000);
          const quality = Math.min(Math.max(settings.webpQuality || 85, 40), 100);
          const webpBuf = await sharp(rawBuf, { failOn: "none" })
            .rotate()
            .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
            .webp({ quality, effort: 4 })
            .toBuffer();
          await persistToCache(webpBuf);
          return webpBuf;
        } catch {
          // continue to URL fallback
        }
      }
    }

    const candidateUrl =
      img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)
        ? img.sourceUrl.trim()
        : img.url && /^https?:\/\//i.test(img.url)
          ? img.url.trim()
          : "";

    if (!candidateUrl) return null;

    const referer =
      productReferer && /^https?:\/\//i.test(productReferer) ? productReferer : candidateUrl;

    // 1) Try standard product image pipeline converter
    const converted = await downloadAndConvertImageToWebp(
      candidateUrl,
      referer,
      settings,
      Boolean(img.isPrimary)
    );
    if (converted) {
      const restoredPath = getWebpFilePath(converted.id);
      if (restoredPath) {
        try {
          const buf = await fs.promises.readFile(restoredPath);
          await persistToCache(buf);
          return buf;
        } catch {
          // continue to direct fallback
        }
      }
    }

    // 2) Direct fallback without strict min-dimension rejection for already-selected product images
    try {
      const res = await fetch(candidateUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
          Referer: referer,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) return null;
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) return null;
      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.length < 50) return null;
      const maxDim = Math.min(Math.max(settings.webpMaxWidth || 1000, 400), 2000);
      const quality = Math.min(Math.max(settings.webpQuality || 85, 40), 100);
      const webpBuf = await sharp(rawBuf, { failOn: "none" })
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      await persistToCache(webpBuf);
      return webpBuf;
    } catch {
      return null;
    }
  }

  app.post("/api/export/zip", async (req, res) => {
    try {
      const products = Array.isArray(req.body?.products)
        ? (req.body.products as EnrichedProduct[])
        : [];
      const settings = sanitizeSettings(req.body?.settings);
      const longDescFormat = req.body?.longDescFormat === "html" ? "html" : "structured";
      const wooPublishCode = req.body?.wooPublishStatus === "publish" ? "1" : "-1";
      const wooImageMode = req.body?.wooImageMode === "source_url" ? "source_url" : "wp_media";
      const rawBaseUrl = typeof req.body?.wpImageBaseUrl === "string" ? req.body.wpImageBaseUrl.trim() : "";
      const normalizedBaseUrl = rawBaseUrl
        ? rawBaseUrl.endsWith("/")
          ? rawBaseUrl
          : `${rawBaseUrl}/`
        : "";

      if (products.length === 0) {
        res.status(400).json({ error: "هیچ کالایی برای خروجی انتخاب نشده است." });
        return;
      }

      const zip = new JSZip();
      const imagesFolder = zip.folder("images");

      const standardHeaders = [
        "Slug",
        "Title_FA",
        "Title_EN",
        "Brand",
        "Category",
        "Model_Code",
        "Short_Description",
        "Long_Description",
        "Specs",
        "WebP_Images",
      ];

      const wooHeaders = [
        "Type",
        "SKU",
        "Name",
        "Published",
        "Is featured?",
        "Visibility in catalog",
        "Short description",
        "Description",
        "In stock?",
        "Categories",
        "Images",
        "Attribute 1 name",
        "Attribute 1 value(s)",
        "Attribute 1 visible",
        "Attribute 1 global",
        "Attribute 2 name",
        "Attribute 2 value(s)",
        "Attribute 2 visible",
        "Attribute 2 global",
        "Attribute 3 name",
        "Attribute 3 value(s)",
        "Attribute 3 visible",
        "Attribute 3 global",
        "Attribute 4 name",
        "Attribute 4 value(s)",
        "Attribute 4 visible",
        "Attribute 4 global",
        "Attribute 5 name",
        "Attribute 5 value(s)",
        "Attribute 5 visible",
        "Attribute 5 global",
        "Attribute 6 name",
        "Attribute 6 value(s)",
        "Attribute 6 visible",
        "Attribute 6 global",
      ];

      const standardRows: string[] = [standardHeaders.join(",")];
      const wooRows: string[] = [wooHeaders.join(",")];
      const jsonExport: unknown[] = [];

      let totalExportedImages = 0;

      for (let pIndex = 0; pIndex < products.length; pIndex++) {
        const p = products[pIndex];
        const slugBase =
          (p.slug || `product-${pIndex + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-") || `product-${pIndex + 1}`;

        const selectedImages = (p.images || []).filter((img) => img.selected !== false);
        const orderedImages = [...selectedImages].sort((a, b) =>
          a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
        );

        const productReferer =
          p.sources?.[0]?.url || p.seedUrl || undefined;

        const resolvedBuffers: (Buffer | null)[] = new Array(orderedImages.length).fill(null);
        let imgCursor = 0;
        const workerCount = Math.min(4, Math.max(1, orderedImages.length));
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (imgCursor < orderedImages.length) {
              const idx = imgCursor;
              imgCursor += 1;
              resolvedBuffers[idx] = await resolveWebpBufferForExport(
                orderedImages[idx] as ExportableWebpImage,
                settings,
                productReferer
              );
            }
          })
        );

        const exportedImageFiles: string[] = [];
        const wooImageUrls: string[] = [];

        for (let i = 0; i < orderedImages.length; i++) {
          const img = orderedImages[i];
          const buf = resolvedBuffers[i];
          const fileName = `${slugBase}-${exportedImageFiles.length + 1}.webp`;

          if (buf && imagesFolder) {
            imagesFolder.file(fileName, buf);
            exportedImageFiles.push(`images/${fileName}`);
            totalExportedImages += 1;
            if (wooImageMode === "source_url" && img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)) {
              wooImageUrls.push(img.sourceUrl);
            } else {
              wooImageUrls.push(normalizedBaseUrl ? `${normalizedBaseUrl}${fileName}` : `images/${fileName}`);
            }
          } else if (wooImageMode === "source_url" && img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)) {
            wooImageUrls.push(img.sourceUrl);
          }
        }

        const longBody =
          longDescFormat === "html" && p.longDescriptionHtml
            ? p.longDescriptionHtml
            : p.longDescription;

        const specsText = (p.specs || []).map((s) => `${s.label}: ${s.value}`).join(" | ");

        standardRows.push(
          [
            slugBase,
            p.titleFa,
            p.titleEn,
            p.brand,
            p.category,
            p.modelCode,
            p.shortDescription,
            longBody,
            specsText,
            exportedImageFiles.join(" ; "),
          ]
            .map(csvEscape)
            .join(",")
        );

        const shortLines = (p.shortDescription || "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const wooShortDescription =
          shortLines.length > 0
            ? `<ul>${shortLines.map((l) => `<li>${l}</li>`).join("")}</ul>`
            : p.shortDescription;

        const attrList: { name: string; val: string }[] = [];
        if (p.brand) attrList.push({ name: "برند", val: p.brand });
        for (const s of (p.specs || []).slice(0, 5)) {
          if (s.label && s.value) attrList.push({ name: s.label, val: s.value });
        }
        const attrCells: string[] = [];
        for (let a = 0; a < 6; a++) {
          const item = attrList[a];
          if (item) {
            attrCells.push(item.name, item.val, "1", "0");
          } else {
            attrCells.push("", "", "", "");
          }
        }

        wooRows.push(
          [
            "simple",
            p.modelCode || slugBase.toUpperCase(),
            p.titleFa || p.query,
            wooPublishCode,
            "0",
            "visible",
            wooShortDescription,
            p.longDescriptionHtml || p.longDescription,
            "1",
            p.category || "تجهیزات پزشکی",
            wooImageUrls.join(", "),
            ...attrCells,
          ]
            .map(csvEscape)
            .join(",")
        );

        jsonExport.push({
          query: p.query,
          slug: slugBase,
          titleFa: p.titleFa,
          titleEn: p.titleEn,
          brand: p.brand,
          category: p.category,
          modelCode: p.modelCode,
          shortDescription: p.shortDescription,
          longDescription: p.longDescription,
          longDescriptionHtml: p.longDescriptionHtml,
          specs: p.specs,
          images: orderedImages.map((img, i) => ({
            id: img.id,
            url: img.url,
            filename: `images/${slugBase}-${i + 1}.webp`,
            width: img.width,
            height: img.height,
            sizeBytes: img.sizeBytes,
            sourceUrl: img.sourceUrl,
            sourceDomain: img.sourceDomain,
            selected: img.selected,
            isPrimary: img.isPrimary,
          })),
          sources: p.sources,
          searchQueries: p.searchQueries,
        });
      }

      zip.file("products.csv", "\uFEFF" + standardRows.join("\n"));
      zip.file("products-woocommerce.csv", "\uFEFF" + wooRows.join("\n"));
      zip.file("products.json", JSON.stringify(jsonExport, null, 2));

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="kalasaz-catalog-webp.zip"`);
      res.setHeader("X-Exported-Images-Count", String(totalExportedImages));
      res.send(zipBuffer);
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/export/json", async (req, res) => {
    try {
      const products = Array.isArray(req.body?.products)
        ? (req.body.products as EnrichedProduct[])
        : [];

      const payload = await Promise.all(
        products.map(async (p, idx) => {
          const slugBase = p.slug || `product-${idx + 1}`;
          const selected = (p.images || []).filter((i) => i.selected);
          const ordered = [...selected].sort((a, b) =>
            a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
          );

          const serializedImages = await Promise.all(
            ordered.map(async (img, i) => {
              let compactDataUrl: string | undefined;
              const webpPath = img.id ? getWebpFilePath(img.id) : null;
              if (webpPath) {
                try {
                  const fileBuf = await fs.promises.readFile(webpPath);
                  const isLocalOrEdited =
                    !img.sourceUrl ||
                    !/^https?:\/\//i.test(img.sourceUrl) ||
                    img.sourceDomain === "upload" ||
                    img.sourceDomain === "edited" ||
                    img.sourceDomain === "edited-canvas";

                  const compactBuf = await sharp(fileBuf, { failOn: "none" })
                    .resize({
                      width: isLocalOrEdited ? 900 : 520,
                      height: isLocalOrEdited ? 900 : 520,
                      fit: "inside",
                      withoutEnlargement: true,
                    })
                    .webp({ quality: isLocalOrEdited ? 78 : 66, effort: 4 })
                    .toBuffer();

                  compactDataUrl = `data:image/webp;base64,${compactBuf.toString("base64")}`;
                } catch {
                  const b64 = await readWebpAsBase64(img.id);
                  if (b64) compactDataUrl = `data:image/webp;base64,${b64}`;
                }
              }

              return {
                id: img.id,
                url: img.url,
                filename: `${slugBase}-${i + 1}.webp`,
                width: img.width,
                height: img.height,
                sizeBytes: img.sizeBytes,
                sourceUrl: img.sourceUrl,
                sourceDomain: img.sourceDomain,
                selected: img.selected,
                isPrimary: img.isPrimary,
                ...(compactDataUrl ? { dataUrl: compactDataUrl } : {}),
              };
            })
          );

          return {
            query: p.query,
            slug: slugBase,
            titleFa: p.titleFa,
            titleEn: p.titleEn,
            brand: p.brand,
            category: p.category,
            modelCode: p.modelCode,
            shortDescription: p.shortDescription,
            longDescription: p.longDescription,
            longDescriptionHtml: p.longDescriptionHtml,
            specs: p.specs,
            images: serializedImages,
            sources: p.sources,
            searchQueries: p.searchQueries,
          };
        })
      );

      res.json(payload);
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/woocommerce/push", async (req, res) => {
    try {
      const body = req.body as {
        product?: EnrichedProduct;
        siteUrl?: string;
        consumerKey?: string;
        consumerSecret?: string;
        wpUsername?: string;
        wpAppPassword?: string;
        publishStatus?: "draft" | "publish";
        settings?: Partial<EnrichmentSettings>;
      };

      const product = body?.product;
      const rawSiteUrl = (body?.siteUrl || "").trim().replace(/\/+$/, "");
      const consumerKey = (body?.consumerKey || "").trim();
      const consumerSecret = (body?.consumerSecret || "").trim();
      const wpUsername = (body?.wpUsername || "").trim();
      const wpAppPassword = (body?.wpAppPassword || "").trim();
      const publishStatus = body?.publishStatus === "publish" ? "publish" : "draft";
      const settings = sanitizeSettings(body?.settings);

      if (!product) {
        res.status(400).json({ error: "اطلاعات محصول ارسال نشده است." });
        return;
      }
      if (!rawSiteUrl || (!rawSiteUrl.startsWith("http://") && !rawSiteUrl.startsWith("https://"))) {
        res.status(400).json({ error: "آدرس سایت وردپرس باید با https:// یا http:// شروع شود." });
        return;
      }
      if (!consumerKey || !consumerSecret) {
        res.status(400).json({ error: "لطفاً Consumer Key و Consumer Secret ووکامرس را وارد کنید." });
        return;
      }

      const wcAuthHeader = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;

      // 1) Upload selected WebP images to WordPress Media Library if WP App Password is provided
      const selectedImages = (product.images || []).filter((img) => img.selected);
      const orderedImages = [...selectedImages].sort((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1
      );
      const slugBase =
        (product.slug || "product").replace(/[^a-zA-Z0-9_-]/g, "-") || "product";

      const wcImagesPayload: { id?: number; src?: string; alt?: string }[] = [];
      let uploadedMediaCount = 0;

      if (wpUsername && wpAppPassword) {
        const wpAuthHeader = `Basic ${Buffer.from(`${wpUsername}:${wpAppPassword}`).toString("base64")}`;

        for (let i = 0; i < orderedImages.length; i++) {
          const img = orderedImages[i];
          const buf = await resolveWebpBufferForExport(
            img as ExportableWebpImage,
            settings,
            product.sources?.[0]?.url || product.seedUrl
          );
          if (!buf) continue;

          const fileName = `${slugBase}-${i + 1}.webp`;
          const mediaRes = await fetch(`${rawSiteUrl}/wp-json/wp/v2/media`, {
            method: "POST",
            headers: {
              Authorization: wpAuthHeader,
              "Content-Type": "image/webp",
              "Content-Disposition": `attachment; filename="${fileName}"`,
            },
            body: new Uint8Array(buf),
            signal: AbortSignal.timeout(20000),
          });

          if (mediaRes.ok) {
            const mediaJson = (await mediaRes.json()) as { id?: number; source_url?: string };
            if (mediaJson.id) {
              wcImagesPayload.push({
                id: mediaJson.id,
                alt: product.titleFa || product.query,
              });
              uploadedMediaCount += 1;
            }
          } else {
            const errTxt = await mediaRes.text().catch(() => "");
            if (mediaRes.status === 401 || mediaRes.status === 403) {
              res.status(401).json({
                error: `خطا در احراز هویت آپلود عکس وردپرس (${mediaRes.status}). نام کاربری یا Application Password را بررسی کنید.`,
                detail: errTxt.slice(0, 300),
              });
              return;
            }
          }
        }
      } else {
        // Fallback: pass public remote sourceUrls directly so WooCommerce sideloads them
        for (const img of orderedImages) {
          if (img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl)) {
            wcImagesPayload.push({
              src: img.sourceUrl,
              alt: product.titleFa || product.query,
            });
          }
        }
      }

      // 2) Resolve or create WooCommerce category
      const categoryName = (product.category || "تجهیزات پزشکی").trim();
      let categoryId: number | null = null;
      try {
        const searchCatRes = await fetch(
          `${rawSiteUrl}/wp-json/wc/v3/products/categories?search=${encodeURIComponent(categoryName)}`,
          {
            headers: { Authorization: wcAuthHeader },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (searchCatRes.ok) {
          const cats = (await searchCatRes.json()) as { id: number; name: string }[];
          const exact = cats.find((c) => c.name.trim() === categoryName) || cats[0];
          if (exact?.id) {
            categoryId = exact.id;
          } else {
            const createCatRes = await fetch(`${rawSiteUrl}/wp-json/wc/v3/products/categories`, {
              method: "POST",
              headers: {
                Authorization: wcAuthHeader,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ name: categoryName }),
              signal: AbortSignal.timeout(10000),
            });
            if (createCatRes.ok) {
              const createdCat = (await createCatRes.json()) as { id?: number };
              if (createdCat.id) categoryId = createdCat.id;
            }
          }
        }
      } catch {
        // Proceed without category ID if lookup fails
      }

      // 3) Create the WooCommerce product (Draft or Publish)
      const shortLines = (product.shortDescription || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const wooShortHtml =
        shortLines.length > 0
          ? `<ul>${shortLines.map((l) => `<li>${l}</li>`).join("")}</ul>`
          : product.shortDescription;

      const attributes = [
        ...(product.brand
          ? [{ name: "برند", visible: true, variation: false, options: [product.brand] }]
          : []),
        ...(product.specs || [])
          .filter((s) => s.label && s.value)
          .slice(0, 10)
          .map((s) => ({
            name: s.label,
            visible: true,
            variation: false,
            options: [s.value],
          })),
      ];

      const wcPayload: Record<string, unknown> = {
        name: product.titleFa || product.query,
        slug: slugBase,
        type: "simple",
        status: publishStatus,
        short_description: wooShortHtml,
        description: product.longDescriptionHtml || product.longDescription,
        ...(product.modelCode ? { sku: product.modelCode } : {}),
        ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
        ...(wcImagesPayload.length > 0 ? { images: wcImagesPayload } : {}),
        ...(attributes.length > 0 ? { attributes } : {}),
      };

      const wcRes = await fetch(`${rawSiteUrl}/wp-json/wc/v3/products`, {
        method: "POST",
        headers: {
          Authorization: wcAuthHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(wcPayload),
        signal: AbortSignal.timeout(25000),
      });

      const wcData = (await wcRes.json().catch(() => ({}))) as {
        id?: number;
        name?: string;
        status?: string;
        permalink?: string;
        message?: string;
        code?: string;
      };

      if (!wcRes.ok || !wcData.id) {
        if (wcData.code === "product_invalid_sku") {
          // Retry without SKU in case SKU already exists on store
          delete wcPayload.sku;
          const retryRes = await fetch(`${rawSiteUrl}/wp-json/wc/v3/products`, {
            method: "POST",
            headers: {
              Authorization: wcAuthHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(wcPayload),
            signal: AbortSignal.timeout(25000),
          });
          const retryData = (await retryRes.json().catch(() => ({}))) as {
            id?: number;
            name?: string;
            status?: string;
            permalink?: string;
            message?: string;
          };
          if (retryRes.ok && retryData.id) {
            res.json({
              id: retryData.id,
              name: retryData.name,
              status: retryData.status,
              permalink: retryData.permalink,
              editUrl: `${rawSiteUrl}/wp-admin/post.php?post=${retryData.id}&action=edit`,
              uploadedMediaCount,
            });
            return;
          }
        }

        res.status(wcRes.status || 400).json({
          error:
            wcData.message ||
            `خطای ووکامرس (${wcRes.status}): اتصال یا دسترسی کلید API را بررسی کنید.`,
        });
        return;
      }

      res.json({
        id: wcData.id,
        name: wcData.name,
        status: wcData.status,
        permalink: wcData.permalink,
        editUrl: `${rawSiteUrl}/wp-admin/post.php?post=${wcData.id}&action=edit`,
        uploadedMediaCount,
      });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/import/json", async (req, res) => {
    try {
      const body = req.body as {
        data?: unknown;
        settings?: Partial<EnrichmentSettings>;
        skipAutoSearch?: boolean;
      };
      const settings = sanitizeSettings(body?.settings);
      const skipAutoSearch = Boolean(body?.skipAutoSearch);
      const rawData = body?.data;

      let rawItems: unknown[] = [];
      if (Array.isArray(rawData)) {
        rawItems = rawData;
      } else if (rawData && typeof rawData === "object") {
        const obj = rawData as Record<string, unknown>;
        if (Array.isArray(obj.products)) {
          rawItems = obj.products;
        } else if (Array.isArray(obj.items)) {
          rawItems = obj.items;
        } else if (Array.isArray(obj.catalog)) {
          rawItems = obj.catalog;
        } else {
          rawItems = [obj];
        }
      }

      const strVal = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

      const normalizeShortDesc = (v: unknown): string => {
        if (Array.isArray(v)) {
          return v
            .map((line) => (typeof line === "string" ? line.trim() : ""))
            .filter(Boolean)
            .map((line) => line.replace(/^[-*•·▪▸►✓✔]\s*/, "").trim())
            .filter(Boolean)
            .join("\n");
        }
        if (typeof v === "string") {
          const splitLines = v
            .split(/\r?\n|(?=[•▪▸►✓✔])/)
            .map((line) => line.replace(/^[-*•·▪▸►✓✔]\s*/, "").trim())
            .filter(Boolean);
          return splitLines.join("\n");
        }
        return "";
      };

      const normalizeSpecs = (v: unknown): { label: string; value: string }[] => {
        if (Array.isArray(v)) {
          return v
            .map((entry) => {
              if (!entry || typeof entry !== "object") return null;
              const rec = entry as Record<string, unknown>;
              const label = strVal(rec.label || rec.key || rec.name || rec.title);
              const value = strVal(rec.value || rec.val || rec.content);
              return label && value ? { label, value } : null;
            })
            .filter((x): x is { label: string; value: string } => x !== null);
        }
        if (v && typeof v === "object") {
          return Object.entries(v as Record<string, unknown>)
            .map(([k, val]) => ({
              label: k.trim(),
              value: typeof val === "string" ? val.trim() : String(val ?? "").trim(),
            }))
            .filter((x) => x.label && x.value);
        }
        return [];
      };

      const normalizeSources = (
        v: unknown
      ): { title: string; url: string; domain: string }[] => {
        if (!Array.isArray(v)) return [];
        return v
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const rec = entry as Record<string, unknown>;
            const url = strVal(rec.url || rec.href);
            if (!url) return null;
            let domain = strVal(rec.domain);
            if (!domain) {
              try {
                domain = new URL(url).hostname.replace(/^www\./, "");
              } catch {
                domain = "source";
              }
            }
            return {
              title: strVal(rec.title || rec.name) || domain,
              url,
              domain,
            };
          })
          .filter(
            (x): x is { title: string; url: string; domain: string } => x !== null
          );
      };

      const extractRawImages = (rec: Record<string, unknown>): unknown[] => {
        const candidates = [
          rec.images,
          rec.photos,
          rec.pictures,
          rec.gallery,
          rec.media,
          rec.Images,
          rec.WebP_Files,
          rec.WebP_Images,
        ];
        for (const cand of candidates) {
          if (Array.isArray(cand) && cand.length > 0) return cand;
          if (typeof cand === "string" && cand.trim()) {
            return cand
              .split(/\s*[;,]\s*|\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
        const single =
          rec.image ||
          rec.imageUrl ||
          rec.image_url ||
          rec.thumbnail ||
          rec.photo ||
          rec.picture;
        if (single) return [single];
        return [];
      };

      interface PendingImageTask {
        productIndex: number;
        imgIndex: number;
        downloadUrl: string;
        pageUrl: string;
        fallbackDataUrl?: string;
        fallbackDomain?: string;
        selected: boolean;
        isPrimary: boolean;
      }

      const importedProducts: EnrichedProduct[] = [];
      const imageTasks: PendingImageTask[] = [];
      const productImagesSlots: (WebpImageAsset | null)[][] = [];

      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const rec = raw as Record<string, unknown>;

        const titleFaRaw = strVal(
          rec.titleFa || rec.title_fa || rec.nameFa || rec.name || rec.title || rec.Title_FA
        );
        const titleEnRaw = strVal(rec.titleEn || rec.title_en || rec.nameEn || rec.Title_EN);
        const queryRaw = strVal(rec.query);
        const slugRaw = strVal(rec.slug || rec.Slug);
        const query = queryRaw || titleFaRaw || titleEnRaw || slugRaw;
        if (!query) continue;

        const titleFa =
          titleFaRaw || (!/^https?:\/\//i.test(query) ? query : "");
        const shortDescription = normalizeShortDesc(
          rec.shortDescription ??
            rec.short_description ??
            rec.Short_Description ??
            rec.highlights ??
            rec.features
        );
        const longDescriptionHtml = strVal(
          rec.longDescriptionHtml || rec.long_description_html || rec.htmlDescription
        );
        const rawLongPlain = strVal(
          rec.longDescription || rec.long_description || rec.Long_Description || rec.description
        );
        const longDescription =
          rawLongPlain ||
          (longDescriptionHtml
            ? longDescriptionHtml
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
            : "");

        const specs = normalizeSpecs(rec.specs || rec.attributes || rec.specifications);
        const sources = normalizeSources(rec.sources);
        const searchQueries = Array.isArray(rec.searchQueries)
          ? rec.searchQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          : [];

        const rawImagesList = extractRawImages(rec);
        const productIndex = importedProducts.length;
        const slots: (WebpImageAsset | null)[] = new Array(rawImagesList.length).fill(null);
        const defaultReferer = sources[0]?.url || "";

        for (let imgIdx = 0; imgIdx < rawImagesList.length; imgIdx++) {
          const entry = rawImagesList[imgIdx];
          if (typeof entry === "string") {
            const trimmed = entry.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("data:image/")) {
              const m = trimmed.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
              if (m) {
                const asset = await convertImageBufferToWebp(
                  Buffer.from(m[1], "base64"),
                  "json-embedded",
                  "https://local-json",
                  settings,
                  imgIdx === 0
                );
                if (asset) slots[imgIdx] = asset;
              }
            } else if (trimmed.startsWith("/api/webp/")) {
              const idGuess = trimmed.split("/").pop()?.replace(/\.webp$/i, "") || "";
              const cachedPath = idGuess ? getWebpFilePath(idGuess) : null;
              if (cachedPath) {
                const stat = await fs.promises.stat(cachedPath);
                const meta = await sharp(cachedPath).metadata().catch(() => ({ width: 0, height: 0 }));
                slots[imgIdx] = {
                  id: idGuess,
                  url: `/api/webp/${idGuess}.webp`,
                  sourceUrl: trimmed,
                  sourceDomain: "local",
                  width: meta.width ?? 0,
                  height: meta.height ?? 0,
                  sizeBytes: stat.size,
                  selected: true,
                  isPrimary: imgIdx === 0,
                };
              }
            } else if (/^https?:\/\//i.test(trimmed)) {
              imageTasks.push({
                productIndex,
                imgIndex: imgIdx,
                downloadUrl: trimmed,
                pageUrl: defaultReferer || trimmed,
                selected: true,
                isPrimary: imgIdx === 0,
              });
            }
            continue;
          }

          if (entry && typeof entry === "object") {
            const imgObj = entry as Record<string, unknown>;
            const rawDataUrl = strVal(imgObj.dataUrl || imgObj.data_url || imgObj.base64);
            const rawUrl = strVal(
              imgObj.url || imgObj.src || imgObj.image || imgObj.imageUrl || imgObj.href || imgObj.link
            );
            const rawSourceUrl = strVal(
              imgObj.sourceUrl || imgObj.source_url || imgObj.originalUrl || rawUrl
            );
            let imgId = strVal(imgObj.id);
            if (!imgId && rawUrl.startsWith("/api/webp/")) {
              imgId = rawUrl.split("/").pop()?.replace(/\.webp$/i, "") || "";
            }
            const selected = imgObj.selected !== false;
            const isPrimary =
              typeof imgObj.isPrimary === "boolean" ? imgObj.isPrimary : imgIdx === 0;

            const isLocalOrEdited =
              rawSourceUrl === "edited-canvas" ||
              strVal(imgObj.sourceDomain) === "upload" ||
              strVal(imgObj.sourceDomain) === "edited";

            const candidateUrl = /^https?:\/\//i.test(rawSourceUrl)
              ? rawSourceUrl
              : /^https?:\/\//i.test(rawUrl)
                ? rawUrl
                : "";

            const cachedPath = imgId ? getWebpFilePath(imgId) : null;
            if (cachedPath && imgId) {
              const stat = await fs.promises.stat(cachedPath);
              const meta = await sharp(cachedPath).metadata().catch(() => ({ width: 0, height: 0 }));
              slots[imgIdx] = {
                id: imgId,
                url: `/api/webp/${imgId}.webp`,
                sourceUrl: rawSourceUrl || rawUrl,
                sourceDomain: strVal(imgObj.sourceDomain) || "local",
                width: Number(imgObj.width) || meta.width || 0,
                height: Number(imgObj.height) || meta.height || 0,
                sizeBytes: Number(imgObj.sizeBytes) || stat.size,
                selected,
                isPrimary,
              };
            } else if (rawDataUrl && (isLocalOrEdited || !candidateUrl)) {
              const b64Match = rawDataUrl.match(/^(?:data:image\/[a-zA-Z0-9+.-]+;base64,)?(.+)$/);
              if (b64Match) {
                const asset = await convertImageBufferToWebp(
                  Buffer.from(b64Match[1], "base64"),
                  rawSourceUrl || "json-embedded",
                  defaultReferer || "https://local-json",
                  settings,
                  isPrimary
                );
                if (asset) {
                  slots[imgIdx] = {
                    ...asset,
                    sourceDomain: strVal(imgObj.sourceDomain) || asset.sourceDomain,
                    selected,
                    isPrimary,
                  };
                  continue;
                }
              }
            } else if (candidateUrl) {
              imageTasks.push({
                productIndex,
                imgIndex: imgIdx,
                downloadUrl: candidateUrl,
                pageUrl: defaultReferer || candidateUrl,
                fallbackDataUrl: rawDataUrl || undefined,
                fallbackDomain: strVal(imgObj.sourceDomain) || undefined,
                selected,
                isPrimary,
              });
            }
          }
        }

        productImagesSlots.push(slots);

        const brand = strVal(rec.brand || rec.Brand);
        const category = strVal(rec.category || rec.Category);
        const modelCode = strVal(rec.modelCode || rec.model_code || rec.sku || rec.SKU);
        const seedUrl = strVal(rec.seedUrl || rec.seed_url || rec.url) || undefined;

        importedProducts.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          query,
          seedUrl,
          status: "pending",
          titleFa,
          titleEn: titleEnRaw,
          slug: slugRaw,
          brand,
          category,
          modelCode,
          shortDescription,
          longDescription,
          longDescriptionHtml,
          specs,
          images: [],
          sources,
          searchQueries,
          updatedAt: Date.now(),
        });
      }

      if (importedProducts.length === 0) {
        res.status(400).json({
          error: "فایل JSON معتبر نیست یا هیچ کالای قابل خواندنی در آن پیدا نشد.",
        });
        return;
      }

      // 1) Re-download & convert missing cached WebP images from sourceUrl (with dataUrl fallback)
      let restoredImagesCount = 0;
      let taskCursor = 0;
      const concurrency = Math.min(4, Math.max(1, imageTasks.length));
      const runImageWorkers = async () => {
        while (taskCursor < imageTasks.length) {
          const idx = taskCursor;
          taskCursor += 1;
          const task = imageTasks[idx];
          let converted = await downloadAndConvertImageToWebp(
            task.downloadUrl,
            task.pageUrl,
            settings,
            task.isPrimary
          );
          if (!converted && task.fallbackDataUrl) {
            const b64Match = task.fallbackDataUrl.match(
              /^(?:data:image\/[a-zA-Z0-9+.-]+;base64,)?(.+)$/
            );
            if (b64Match) {
              converted = await convertImageBufferToWebp(
                Buffer.from(b64Match[1], "base64"),
                task.downloadUrl,
                task.pageUrl,
                settings,
                task.isPrimary
              );
            }
          }
          if (converted) {
            productImagesSlots[task.productIndex][task.imgIndex] = {
              ...converted,
              sourceDomain: task.fallbackDomain || converted.sourceDomain,
              selected: task.selected,
              isPrimary: task.isPrimary,
            };
            restoredImagesCount += 1;
          }
        }
      };
      if (imageTasks.length > 0) {
        await Promise.all(Array.from({ length: concurrency }, () => runImageWorkers()));
      }

      // 2) Assign restored images and identify enriched items still missing images
      const autoFetchIndices: number[] = [];
      for (let i = 0; i < importedProducts.length; i++) {
        const imgs = productImagesSlots[i].filter((img): img is WebpImageAsset => img !== null);
        if (imgs.length > 0 && !imgs.some((img) => img.isPrimary)) {
          imgs[0] = { ...imgs[0], isPrimary: true };
        }
        const p = importedProducts[i];
        p.images = imgs;
        const hasTextContent = Boolean(
          p.shortDescription ||
            p.longDescription ||
            p.longDescriptionHtml ||
            p.specs.length > 0
        );
        p.status = hasTextContent || imgs.length > 0 ? "done" : "pending";

        if (imgs.length === 0 && (p.titleFa || p.titleEn || p.query)) {
          autoFetchIndices.push(i);
        }
      }

      // Auto-fetch images for up to first 3 image-less products right away when skipAutoSearch is false
      const immediateAutoFetch = skipAutoSearch ? [] : autoFetchIndices.slice(0, 3);
      if (immediateAutoFetch.length > 0) {
        let fetchCursor = 0;
        const fetchWorkers = Math.min(2, immediateAutoFetch.length);
        const runAutoFetch = async () => {
          while (fetchCursor < immediateAutoFetch.length) {
            const pIdx = immediateAutoFetch[fetchCursor];
            fetchCursor += 1;
            const p = importedProducts[pIdx];
            try {
              const found = await collectWebpImagesForProduct({
                pageUrls: [
                  ...p.sources.map((s) => s.url),
                  ...(p.seedUrl ? [p.seedUrl] : []),
                ],
                directImageUrls: [],
                query: p.titleFa || p.query,
                titleEn: p.titleEn || p.titleFa || p.query,
                settings,
              });
              if (found.length > 0) {
                p.images = found;
                restoredImagesCount += found.length;
              }
            } catch {
              // Skip if image fetch fails
            }
          }
        };
        await Promise.all(Array.from({ length: fetchWorkers }, () => runAutoFetch()));
      }

      res.json({
        products: importedProducts,
        restoredImagesCount,
      });
    } catch (err) {
      const { status, message } = formatErrorMessage(err);
      res.status(status).json({ error: message });
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "مسیر API مورد نظر یافت نشد." });
  });

  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const typedErr = err as { type?: string; status?: number; statusCode?: number; message?: string };
      if (typedErr?.type === "entity.too.large" || typedErr?.status === 413) {
        res.status(413).json({
          error: "حجم فایل ارسالی بیش از حد مجاز است. لطفاً تصویر با حجم کمتر انتخاب کنید.",
        });
        return;
      }
      if (req.path.startsWith("/api/")) {
        const status = typedErr?.status || typedErr?.statusCode || 500;
        res.status(status).json({
          error: typedErr?.message || "خطا در پردازش درخواست سرور.",
        });
        return;
      }
      next(err);
    }
  );

  // Serve the built SPA when a build exists; otherwise fall back to Vite dev.
  // Deciding on the build output (not only NODE_ENV) avoids crashing in
  // production when NODE_ENV was not set by the host.
  const distPath = path.resolve(process.cwd(), "dist");
  const hasBuild = fs.existsSync(path.join(distPath, "index.html"));

  if (hasBuild) {
    app.use(express.static(distPath));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
