import { useCallback, useEffect, useRef, useState } from "react";
import { FolderArchive, Loader2 } from "lucide-react";
import { A4ScannerModal } from "./components/A4ScannerModal.tsx";
import { CatalogTableView } from "./components/CatalogTableView.tsx";
import { ProductInspector } from "./components/ProductInspector.tsx";
import {
  ProductQueueSidebar,
  type QueueItemInput,
} from "./components/ProductQueueSidebar.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import {
  DEFAULT_SETTINGS,
  type EnrichedProduct,
  type EnrichmentSettings,
} from "./types/product.ts";
import { downloadProductsZip } from "./utils/exportHelpers.ts";
import { backupWebpFromUrl } from "./utils/webpBackupDb.ts";

type ActiveTab = "workspace" | "catalog" | "settings";

const STORAGE_PRODUCTS_KEY = "kalasaz_products_v1";
const STORAGE_SETTINGS_KEY = "kalasaz_settings_v1";

function createProductStub(item: QueueItemInput): EnrichedProduct {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    query: item.query,
    seedUrl: item.seedUrl,
    seedImage: item.seedImage,
    status: "pending",
    titleFa: "",
    titleEn: "",
    slug: "",
    brand: "",
    category: "",
    modelCode: "",
    shortDescription: "",
    longDescription: "",
    longDescriptionHtml: "",
    specs: [],
    images: item.seedImage ? [item.seedImage] : [],
    sources: [],
    searchQueries: [],
    updatedAt: Date.now(),
  };
}

function loadInitialProducts(): EnrichedProduct[] {
  try {
    const raw = localStorage.getItem(STORAGE_PRODUCTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as EnrichedProduct[];
    if (!Array.isArray(parsed)) return [];
    // Recover any interrupted processing items back to pending
    return parsed.map((p) =>
      p.status === "processing" ? { ...p, status: "pending" } : p
    );
  } catch {
    return [];
  }
}

function loadInitialSettings(): EnrichmentSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<EnrichmentSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("workspace");
  const [products, setProducts] = useState<EnrichedProduct[]>(loadInitialProducts);
  const [settings, setSettings] = useState<EnrichmentSettings>(loadInitialSettings);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = loadInitialProducts();
    return initial[0]?.id ?? null;
  });
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);

  const productsRef = useRef<EnrichedProduct[]>(products);
  productsRef.current = products;

  const settingsRef = useRef<EnrichmentSettings>(settings);
  settingsRef.current = settings;

  const stopRequestedRef = useRef(false);
  const backedUpIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PRODUCTS_KEY, JSON.stringify(products));
    } catch {
      // Ignore storage quota errors
    }

    for (const p of products) {
      for (const img of p.images) {
        if (img.id && img.url?.startsWith("/api/webp/") && !backedUpIdsRef.current.has(img.id)) {
          backedUpIdsRef.current.add(img.id);
          void backupWebpFromUrl(img.id, img.url);
        }
      }
    }
  }, [products]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage quota errors
    }
  }, [settings]);

  const updateProduct = useCallback((id: string, patch: Partial<EnrichedProduct>) => {
    setProducts((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
      )
    );
  }, []);

  const enrichSingleProduct = useCallback(
    async (item: EnrichedProduct) => {
      updateProduct(item.id, { status: "processing", errorMessage: undefined });

      const maxClientAttempts = 2;
      let lastErrMsg = "خطا در پردازش کالا";

      for (let attempt = 1; attempt <= maxClientAttempts; attempt++) {
        try {
          const res = await fetch("/api/products/enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: item.query,
              seedUrl: item.seedUrl,
              seedImage: item.seedImage,
              settings: settingsRef.current,
            }),
          });

          const rawText = await res.text();
          let data: (Partial<EnrichedProduct> & { error?: string }) | null = null;
          try {
            data = JSON.parse(rawText) as Partial<EnrichedProduct> & { error?: string };
          } catch {
            data = null;
          }

          if (!data || !res.ok) {
            const msg =
              data?.error ||
              (res.status === 502 || res.status === 503 || res.status === 504
                ? "سرویس پردازش موقتاً شلوغ است یا زمان پاسخ به پایان رسید. دوباره تلاش کنید."
                : `خطا در جستجو و دریافت اطلاعات کالا (کد ${res.status})`);
            if ((res.status === 503 || res.status === 504 || res.status === 429) && attempt < maxClientAttempts) {
              lastErrMsg = msg;
              const waitMs = res.status === 429 ? 6000 : 3500;
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              if (stopRequestedRef.current) break;
              continue;
            }
            throw new Error(msg);
          }

          updateProduct(item.id, {
            status: "done",
            titleFa: data.titleFa || item.query,
            titleEn: data.titleEn || "",
            slug: data.slug || "",
            brand: data.brand || "",
            category: data.category || "",
            modelCode: data.modelCode || "",
            shortDescription: data.shortDescription || "",
            longDescription: data.longDescription || "",
            longDescriptionHtml: data.longDescriptionHtml || "",
            specs: Array.isArray(data.specs) ? data.specs : [],
            images: Array.isArray(data.images) ? data.images : [],
            sources: Array.isArray(data.sources) ? data.sources : [],
            searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries : [],
          });
          return;
        } catch (err) {
          lastErrMsg = err instanceof Error ? err.message : "خطا در پردازش کالا";
          if (
            attempt < maxClientAttempts &&
            (lastErrMsg.includes("شلوغ") || lastErrMsg.includes("سهمیه") || lastErrMsg.includes("429"))
          ) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (stopRequestedRef.current) break;
            continue;
          }
          break;
        }
      }

      updateProduct(item.id, {
        status: "error",
        errorMessage: lastErrMsg,
      });
    },
    [updateProduct]
  );

  const runBatchQueue = useCallback(
    async (explicitItems?: EnrichedProduct[]) => {
      if (isBatchRunning) return;
      stopRequestedRef.current = false;
      setIsBatchRunning(true);

      const queue =
        explicitItems ??
        productsRef.current.filter(
          (p) => p.status === "pending" || p.status === "error"
        );
      let cursor = 0;

      const worker = async () => {
        while (!stopRequestedRef.current) {
          const index = cursor;
          cursor += 1;
          if (index >= queue.length) break;
          const item = queue[index];
          await enrichSingleProduct(item);
          if (!stopRequestedRef.current && cursor < queue.length) {
            const keyCount = (settingsRef.current.geminiApiKey || "")
              .split(/[\r\n,;\s]+/)
              .map((s) => s.trim())
              .filter((s) => s.length >= 10).length;
            const paceMs = keyCount >= 2 ? 900 : settingsRef.current.freeTierSaver !== false ? 2400 : 800;
            await new Promise((resolve) => setTimeout(resolve, paceMs));
          }
        }
      };

      // Process sequentially one-by-one so large A4 scanned lists run reliably without burst limits
      await worker();

      setIsBatchRunning(false);
    },
    [enrichSingleProduct, isBatchRunning]
  );

  const handleAddProducts = useCallback(
    (items: QueueItemInput[], autoStart = false) => {
      const stubs = items.map((item) => createProductStub(item));
      setProducts((prev) => [...prev, ...stubs]);
      if (stubs[0]) {
        setSelectedId(stubs[0].id);
      }
      if (autoStart && stubs.length > 0) {
        void runBatchQueue(stubs);
      }
    },
    [runBatchQueue]
  );

  const handleImportProducts = useCallback((imported: EnrichedProduct[]): EnrichedProduct[] => {
    if (imported.length === 0) return [];
    const existingIds = new Set(productsRef.current.map((p) => p.id));
    const sanitized = imported.map((item, idx) => {
      const nextId = existingIds.has(item.id)
        ? `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`
        : item.id;
      existingIds.add(nextId);
      return { ...item, id: nextId, updatedAt: Date.now() };
    });
    setProducts((prev) => [...prev, ...sanitized]);
    if (sanitized[0]) {
      setSelectedId(sanitized[0].id);
    }
    return sanitized;
  }, []);

  const handleRetryProduct = useCallback(
    (id: string) => {
      const target = productsRef.current.find((p) => p.id === id);
      if (!target) return;
      void enrichSingleProduct(target);
    },
    [enrichSingleProduct]
  );

  const handleDeleteProduct = useCallback(
    (id: string) => {
      setProducts((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (selectedId === id) {
          setSelectedId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [selectedId]
  );

  const handleClearCompleted = useCallback(() => {
    setProducts((prev) => {
      const next = prev.filter((p) => p.status !== "done");
      if (selectedId && !next.some((p) => p.id === selectedId)) {
        setSelectedId(next[0]?.id ?? null);
      }
      return next;
    });
  }, [selectedId]);

  const handleHeaderExportZip = async () => {
    const ready = products.filter((p) => p.status === "done");
    if (ready.length === 0) {
      setGlobalNotice("ابتدا حداقل یک کالا را پردازش کنید تا آماده خروجی ZIP شود.");
      setTimeout(() => setGlobalNotice(null), 3500);
      return;
    }
    setIsExportingZip(true);
    setGlobalNotice(null);
    try {
      await downloadProductsZip(
        ready,
        settings.longDescFormat,
        settings.wpImageBaseUrl,
        { settings }
      );
    } catch (err) {
      setGlobalNotice(err instanceof Error ? err.message : "خطا در دانلود ZIP");
      setTimeout(() => setGlobalNotice(null), 4000);
    } finally {
      setIsExportingZip(false);
    }
  };

  const selectedProduct = products.find((p) => p.id === selectedId) ?? null;
  const readyCount = products.filter((p) => p.status === "done").length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 h-[57px] bg-white border-b border-slate-200 px-5 lg:px-6 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Wordmark (single element) */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab("workspace");
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          کالاساز
        </a>

        {/* Zone 2: Clean single-line navigation links */}
        <nav className="flex items-center gap-6 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("workspace")}
            className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === "workspace"
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            میز کار و صف کالاها
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("catalog")}
            className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
              activeTab === "catalog"
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            جدول کاتالوگ ({readyCount})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === "settings"
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            تنظیمات و پروایدرها
          </button>
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleHeaderExportZip}
            disabled={isExportingZip || readyCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isExportingZip ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FolderArchive className="w-3.5 h-3.5" />
            )}
            خروجی کامل ZIP
          </button>
        </div>
      </header>

      {globalNotice && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-800 text-center">
          {globalNotice}
        </div>
      )}

      {/* Main Content Area */}
      {activeTab === "workspace" && (
        <div className="flex-1 flex flex-col lg:flex-row lg:overflow-hidden">
          <ProductQueueSidebar
            products={products}
            settings={settings}
            selectedId={selectedId}
            isBatchRunning={isBatchRunning}
            onSelectProduct={(id) => setSelectedId(id)}
            onAddProducts={(items, autoStart) => handleAddProducts(items, autoStart)}
            onImportProducts={handleImportProducts}
            onStartBatch={() => void runBatchQueue()}
            onStopBatch={() => {
              stopRequestedRef.current = true;
            }}
            onDeleteProduct={handleDeleteProduct}
            onClearCompleted={handleClearCompleted}
            onOpenScanner={() => setIsScannerOpen(true)}
          />

          <ProductInspector
            product={selectedProduct}
            settings={settings}
            onUpdateProduct={updateProduct}
            onRetryProduct={handleRetryProduct}
            onDeleteProduct={handleDeleteProduct}
            onQuickAddAndRun={(items) => handleAddProducts(items, true)}
            onOpenScanner={() => setIsScannerOpen(true)}
          />
        </div>
      )}

      {activeTab === "catalog" && (
        <CatalogTableView
          products={products}
          settings={settings}
          onInspectProduct={(id) => {
            setSelectedId(id);
            setActiveTab("workspace");
          }}
          onDeleteProduct={handleDeleteProduct}
          onImportProducts={handleImportProducts}
          onUpdateProduct={updateProduct}
        />
      )}

      {activeTab === "settings" && (
        <SettingsPanel settings={settings} onChange={setSettings} />
      )}

      <A4ScannerModal
        isOpen={isScannerOpen}
        domainProfile={settings.domainProfile}
        settings={settings}
        onClose={() => setIsScannerOpen(false)}
        onConfirmItems={(names, autoStart) => {
          handleAddProducts(
            names.map((q) => ({ query: q })),
            autoStart
          );
        }}
      />
    </div>
  );
}
