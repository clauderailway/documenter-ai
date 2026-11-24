import * as cheerio from "cheerio";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { EnrichmentSettings, WebpImageAsset } from "../src/types/product.ts";

const CACHE_DIR = path.resolve(process.cwd(), ".cache", "webp");

export function ensureWebpCacheDir(): string {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return CACHE_DIR;
}

export function getWebpFilePath(imageId: string): string | null {
  const safeId = imageId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) return null;
  const fullPath = path.join(ensureWebpCacheDir(), `${safeId}.webp`);
  return fs.existsSync(fullPath) ? fullPath : null;
}

export async function readWebpAsBase64(imageId: string): Promise<string | null> {
  const filePath = getWebpFilePath(imageId);
  if (!filePath) return null;
  try {
    const buf = await fs.promises.readFile(filePath);
    return buf.toString("base64");
  } catch {
    return null;
  }
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
};

const BLOCKED_URL_PATTERNS = [
  "logo",
  "favicon",
  "sprite",
  "icon",
  "avatar",
  "badge",
  "spinner",
  "loader",
  "placeholder",
  "blank.",
  "1x1",
  "pixel",
  "analytics",
  "doubleclick",
  "facebook.com/tr",
  "googletagmanager",
  "flag-",
  "/flags/",
  "payment",
  "visa",
  "mastercard",
  "enamad",
  "samandehi",
  ".svg",
];

function isLikelyProductImageUrl(urlStr: string): boolean {
  const lower = urlStr.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  if (lower.startsWith("data:")) return false;
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (lower.includes(pattern)) return false;
  }
  return true;
}

function resolveUrl(raw: string, baseUrl: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("data:")) return null;
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function pickBestFromSrcset(srcset: string, baseUrl: string): string | null {
  const parts = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let bestUrl: string | null = null;
  let bestScore = -1;

  for (const part of parts) {
    const tokens = part.split(/\s+/);
    const urlPart = tokens[0];
    const descriptor = tokens[1] || "";
    const resolved = resolveUrl(urlPart, baseUrl);
    if (!resolved) continue;

    let score = 1;
    if (descriptor.endsWith("w")) {
      score = parseInt(descriptor, 10) || 1;
    } else if (descriptor.endsWith("x")) {
      score = Math.round((parseFloat(descriptor) || 1) * 500);
    }
    if (score > bestScore) {
      bestScore = score;
      bestUrl = resolved;
    }
  }
  return bestUrl;
}

function collectJsonLdImages(node: unknown, baseUrl: string, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdImages(item, baseUrl, out);
    return;
  }
  if (typeof node === "string") {
    const resolved = resolveUrl(node, baseUrl);
    if (resolved && isLikelyProductImageUrl(resolved)) out.push(resolved);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.image) {
      collectJsonLdImages(obj.image, baseUrl, out);
    }
    if (obj.url && typeof obj.url === "string" && obj["@type"] === "ImageObject") {
      const resolved = resolveUrl(obj.url, baseUrl);
      if (resolved && isLikelyProductImageUrl(resolved)) out.push(resolved);
    }
    if (obj.contentUrl && typeof obj.contentUrl === "string") {
      const resolved = resolveUrl(obj.contentUrl, baseUrl);
      if (resolved && isLikelyProductImageUrl(resolved)) out.push(resolved);
    }
    if (obj["@graph"]) {
      collectJsonLdImages(obj["@graph"], baseUrl, out);
    }
    if (obj.mainEntity) {
      collectJsonLdImages(obj.mainEntity, baseUrl, out);
    }
  }
}

interface CandidateImage {
  imageUrl: string;
  pageUrl: string;
  priority: number;
}

async function tryFetchDigikalaProductImages(resolvedUrl: string): Promise<string[]> {
  const match = resolvedUrl.match(/digikala\.com\/product\/dkp-(\d+)/i);
  if (!match) return [];
  const dkpId = match[1];
  try {
    const res = await fetch(`https://api.digikala.com/v2/product/${dkpId}/`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: {
        product?: {
          images?: {
            main?: { url?: string[] };
            list?: Array<{ url?: string[] }>;
          };
        };
      };
    };
    const imgs: string[] = [];
    const mainUrls = data?.data?.product?.images?.main?.url ?? [];
    if (mainUrls[0]) imgs.push(mainUrls[0]);
    const list = data?.data?.product?.images?.list ?? [];
    for (const item of list) {
      if (item?.url?.[0]) imgs.push(item.url[0]);
    }
    return imgs;
  } catch {
    return [];
  }
}

async function tryFetchShopifyImages(resolvedUrl: string): Promise<string[]> {
  if (!resolvedUrl.includes("/products/")) return [];
  try {
    const cleanUrl = resolvedUrl.split("?")[0].replace(/\/$/, "");
    const res = await fetch(`${cleanUrl}.json`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      product?: { images?: Array<{ src?: string }> };
    };
    return (data?.product?.images ?? [])
      .map((img) => img.src)
      .filter((s): s is string => typeof s === "string" && s.startsWith("http"));
  } catch {
    return [];
  }
}

export async function scrapeImagesFromPage(pageUrl: string): Promise<CandidateImage[]> {
  const candidates: CandidateImage[] = [];
  const seen = new Set<string>();

  const pushCandidate = (imgUrl: string | null, sourcePage: string, priority: number) => {
    if (!imgUrl || seen.has(imgUrl)) return;
    if (!isLikelyProductImageUrl(imgUrl)) return;
    seen.add(imgUrl);
    candidates.push({ imageUrl: imgUrl, pageUrl: sourcePage, priority });
  };

  try {
    const res = await fetch(pageUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(6500),
    });

    if (!res.ok) return candidates;
    const resolvedUrl = res.url || pageUrl;
    const contentType = res.headers.get("content-type") || "";

    // If URL itself is a direct image
    if (contentType.startsWith("image/")) {
      pushCandidate(resolvedUrl, resolvedUrl, 100);
      return candidates;
    }

    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return candidates;
    }

    // Parallel specialized store extractors (Digikala / Shopify)
    const [dkImgs, shopifyImgs] = await Promise.all([
      tryFetchDigikalaProductImages(resolvedUrl),
      tryFetchShopifyImages(resolvedUrl),
    ]);
    for (const u of dkImgs) pushCandidate(u, resolvedUrl, 98);
    for (const u of shopifyImgs) pushCandidate(u, resolvedUrl, 95);

    const html = await res.text();
    const $ = cheerio.load(html);

    // 1. JSON-LD Product Images (Highest signal)
    $('script[type="application/ld+json"]').each((_, el) => {
      const rawJson = $(el).text();
      if (!rawJson) return;
      try {
        const parsed = JSON.parse(rawJson);
        const extracted: string[] = [];
        collectJsonLdImages(parsed, resolvedUrl, extracted);
        for (const u of extracted) {
          pushCandidate(u, resolvedUrl, 90);
        }
      } catch {
        // Ignore malformed JSON-LD blocks
      }
    });

    // 2. OpenGraph / Twitter Meta Tags
    const ogSelectors = [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
    ];
    for (const sel of ogSelectors) {
      $(sel).each((_, el) => {
        const content = $(el).attr("content");
        if (content) {
          pushCandidate(resolveUrl(content, resolvedUrl), resolvedUrl, 80);
        }
      });
    }

    // 3. Product Gallery & High-res <img> Tags
    $("img").each((_, el) => {
      const $img = $(el);
      const alt = ($img.attr("alt") || "").toLowerCase();
      const cls = ($img.attr("class") || "").toLowerCase();
      if (cls.includes("logo") || alt.includes("logo") || cls.includes("avatar")) {
        return;
      }

      const priorityAttrs = [
        $img.attr("data-zoom-image"),
        $img.attr("data-large_image"),
        $img.attr("data-full-src"),
        $img.attr("data-original"),
        $img.attr("data-src"),
      ];

      for (const attrVal of priorityAttrs) {
        if (attrVal) {
          pushCandidate(resolveUrl(attrVal, resolvedUrl), resolvedUrl, 70);
        }
      }

      const srcset = $img.attr("srcset") || $img.attr("data-srcset");
      if (srcset) {
        const best = pickBestFromSrcset(srcset, resolvedUrl);
        if (best) pushCandidate(best, resolvedUrl, 65);
      }

      const src = $img.attr("src");
      if (src) {
        pushCandidate(resolveUrl(src, resolvedUrl), resolvedUrl, 50);
      }
    });
  } catch {
    // Gracefully skip unreachable or timed-out pages
  }

  return candidates;
}

export interface WebImageSearchHit {
  imageUrl: string;
  pageUrl: string;
  title: string;
}

export async function searchWebProductImages(query: string): Promise<WebImageSearchHit[]> {
  const hits: WebImageSearchHit[] = [];
  const seen = new Set<string>();
  try {
    const res = await fetch(
      `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`,
      {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(5500),
      }
    );
    if (!res.ok) return hits;
    const html = await res.text();
    const $ = cheerio.load(html);

    $("a.iusc").each((_, el) => {
      const mAttr = $(el).attr("m");
      if (!mAttr) return;
      try {
        const parsed = JSON.parse(mAttr) as {
          murl?: string;
          purl?: string;
          t?: string;
        };
        const murl = parsed.murl?.trim();
        const purl = parsed.purl?.trim() || murl;
        const title = parsed.t?.trim() || "";
        if (murl && isLikelyProductImageUrl(murl) && !seen.has(murl)) {
          seen.add(murl);
          hits.push({
            imageUrl: murl,
            pageUrl: purl || murl,
            title,
          });
        }
      } catch {
        // Ignore malformed attribute
      }
    });
  } catch {
    // Graceful skip
  }
  return hits;
}

export async function convertImageBufferToWebp(
  buffer: Buffer,
  sourceUrl: string,
  sourcePageUrl: string,
  settings: EnrichmentSettings,
  isPrimary: boolean
): Promise<WebpImageAsset | null> {
  try {
    const metadata = await sharp(buffer, { failOn: "none" }).metadata();
    const origW = metadata.width ?? 0;
    const origH = metadata.height ?? 0;

    // Reject tiny icons, spacers, or extreme banners
    if (origW < 220 || origH < 220) return null;
    const ratio = origW / origH;
    if (ratio > 3.8 || ratio < 0.26) return null;

    const maxDim = Math.min(Math.max(settings.webpMaxWidth || 1000, 400), 2000);
    const quality = Math.min(Math.max(settings.webpQuality || 85, 40), 100);

    let pipeline = sharp(buffer, { failOn: "none" }).rotate();

    if (settings.webpFitMode === "contain_white") {
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

    const id = crypto.randomBytes(8).toString("hex");
    const filePath = path.join(ensureWebpCacheDir(), `${id}.webp`);
    await fs.promises.writeFile(filePath, webpBuffer);

    let domain = "local";
    try {
      domain = new URL(sourcePageUrl || sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      domain = "upload";
    }

    return {
      id,
      url: `/api/webp/${id}.webp`,
      sourceUrl,
      sourceDomain: domain,
      width: outMeta.width ?? origW,
      height: outMeta.height ?? origH,
      sizeBytes: webpBuffer.length,
      selected: true,
      isPrimary,
    };
  } catch {
    return null;
  }
}

export async function downloadAndConvertImageToWebp(
  imageUrl: string,
  pageUrl: string,
  settings: EnrichmentSettings,
  isPrimary: boolean
): Promise<WebpImageAsset | null> {
  try {
    let origin = "";
    try {
      origin = new URL(pageUrl || imageUrl).origin;
    } catch {
      origin = "";
    }

    const res = await fetch(imageUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8",
        ...(origin ? { Referer: origin } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });

    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("svg") || contentType.includes("text/html")) return null;

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength < 4000 || arrayBuf.byteLength > 14 * 1024 * 1024) {
      return null;
    }

    return await convertImageBufferToWebp(
      Buffer.from(arrayBuf),
      imageUrl,
      pageUrl,
      settings,
      isPrimary
    );
  } catch {
    return null;
  }
}

export async function collectWebpImagesForProduct(params: {
  pageUrls: string[];
  directImageUrls: string[];
  query: string;
  titleEn: string;
  settings: EnrichmentSettings;
}): Promise<WebpImageAsset[]> {
  const { pageUrls, directImageUrls, query, titleEn, settings } = params;
  const targetCount = Math.min(Math.max(settings.targetImageCount || 5, 1), 12);

  // Scrape candidate pages in parallel (up to 7 pages)
  const uniquePages = Array.from(new Set(pageUrls)).slice(0, 7);
  const scrapedLists = await Promise.all(uniquePages.map((u) => scrapeImagesFromPage(u)));

  let allCandidates: CandidateImage[] = [];

  for (const imgUrl of directImageUrls) {
    if (isLikelyProductImageUrl(imgUrl)) {
      allCandidates.push({ imageUrl: imgUrl, pageUrl: imgUrl, priority: 95 });
    }
  }
  for (const list of scrapedLists) {
    allCandidates.push(...list);
  }

  // If we still need more candidates, search web product images directly
  if (allCandidates.length < targetCount * 2) {
    const queries = Array.from(new Set([query, titleEn].filter((q) => q && q.trim().length > 1)));
    const webHitsList = await Promise.all(queries.map((q) => searchWebProductImages(q)));
    for (const hits of webHitsList) {
      for (const hit of hits.slice(0, 8)) {
        allCandidates.push({
          imageUrl: hit.imageUrl,
          pageUrl: hit.pageUrl,
          priority: 85,
        });
      }
    }
  }

  // Deduplicate & sort by priority
  const seenImgUrl = new Set<string>();
  allCandidates = allCandidates
    .sort((a, b) => b.priority - a.priority)
    .filter((c) => {
      const normalized = c.imageUrl.split("?")[0];
      if (seenImgUrl.has(c.imageUrl) || seenImgUrl.has(normalized)) return false;
      seenImgUrl.add(c.imageUrl);
      seenImgUrl.add(normalized);
      return true;
    })
    .slice(0, targetCount * 3 + 4);

  const results: WebpImageAsset[] = [];
  const seenSignatures = new Set<string>();

  // Process candidates in small batches until we reach targetCount
  const chunkSize = 4;
  for (let i = 0; i < allCandidates.length && results.length < targetCount; i += chunkSize) {
    const slice = allCandidates.slice(i, i + chunkSize);
    const converted = await Promise.all(
      slice.map((c) =>
        downloadAndConvertImageToWebp(
          c.imageUrl,
          c.pageUrl,
          settings,
          results.length === 0
        )
      )
    );

    for (const asset of converted) {
      if (!asset) continue;
      // Avoid near-identical image files (same dimensions & very close size)
      const sig = `${asset.width}x${asset.height}-${Math.round(asset.sizeBytes / 1024)}`;
      if (seenSignatures.has(sig)) continue;
      seenSignatures.add(sig);

      asset.isPrimary = results.length === 0;
      results.push(asset);
      if (results.length >= targetCount) break;
    }
  }

  return results;
}
