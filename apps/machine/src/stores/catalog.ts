import { defineStore } from "pinia";

import type { SaleViewMediaDiagnostic } from "@/daemon/schemas";
import type {
  MachineCatalogItem,
  MachineCatalogSlotCandidate,
  MachineCatalogVariantCandidate,
  MachineSaleViewItem,
} from "@/types/catalog";

import { daemonClient } from "@/daemon/client";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 5_000;
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL"] as const;
type KnownSize = (typeof SIZE_ORDER)[number];

export type CatalogMediaDiagnostic = {
  reference: string | null;
  diagnosticKey: string;
  message: string;
  recordedAt: string;
};

export type CatalogOperatorDiagnostic = CatalogMediaDiagnostic & {
  kind: "media" | "category" | "try_on";
};

let refreshInFlight: Promise<void> | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshConsumers = 0;

function catalogKeyFor(item: Pick<MachineSaleViewItem, "productId">): string {
  return `product:${item.productId}`;
}

function mediaDiagnosticKey(reference: string | null | undefined): string {
  return `media:${reference ?? "missing"}`;
}

function slotCandidateFor(
  candidate: MachineSaleViewItem,
): MachineCatalogSlotCandidate {
  return {
    slotId: candidate.slotId,
    slotCode: candidate.slotCode,
    layerNo: candidate.layerNo,
    cellNo: candidate.cellNo,
    inventoryId: candidate.inventoryId,
    variantId: candidate.variantId,
    sku: candidate.sku,
    size: candidate.size,
    color: candidate.color,
    priceCents: candidate.priceCents,
    capacity: candidate.capacity,
    parLevel: candidate.parLevel,
    physicalStock: candidate.physicalStock,
    saleableStock: candidate.saleableStock,
    slotSalesState: candidate.slotSalesState,
  };
}

function sizeRank(size: string | null): number {
  if (!size) return Number.MAX_SAFE_INTEGER;
  const knownSize: KnownSize | undefined = SIZE_ORDER.find(
    (candidate) => candidate === size,
  );
  if (!knownSize) return Number.MAX_SAFE_INTEGER;
  const index = SIZE_ORDER.indexOf(knownSize);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function asCatalogItem(
  item: MachineSaleViewItem,
  slotCandidates = [item],
): MachineCatalogItem {
  const mappedSlotCandidates = slotCandidates.map(slotCandidateFor);
  return {
    ...item,
    catalogKey: catalogKeyFor(item),
    aggregatedSlotCount: mappedSlotCandidates.length,
    slotCandidates: mappedSlotCandidates,
    variantCandidates: [
      {
        variantId: item.variantId,
        sku: item.sku,
        size: item.size,
        color: item.color,
        priceCents: item.priceCents,
        tryOnSilhouetteUrl: item.tryOnSilhouetteUrl ?? null,
        capacity: item.capacity,
        parLevel: item.parLevel,
        physicalStock: item.physicalStock,
        saleableStock: item.saleableStock,
        slotSalesState: item.slotSalesState,
        slotCandidates: mappedSlotCandidates,
      },
    ],
  };
}

function concreteSaleableItem(
  items: MachineCatalogItem[],
  variantId?: string,
): MachineCatalogItem | null {
  const candidates = items
    .filter(
      (item) =>
        (variantId === undefined || item.variantId === variantId) &&
        item.slotSalesState === "sale_ready" &&
        item.saleableStock > 0,
    )
    .sort(
      (a, b) =>
        a.productSortOrder - b.productSortOrder ||
        a.priceCents - b.priceCents ||
        a.layerNo - b.layerNo ||
        a.cellNo - b.cellNo ||
        a.slotCode.localeCompare(b.slotCode),
    );
  return candidates[0] ?? null;
}

function aggregateVariantCandidates(
  group: MachineCatalogItem[],
): MachineCatalogVariantCandidate[] {
  const variants = new Map<string, MachineCatalogItem[]>();
  for (const item of group) {
    const variantGroup = variants.get(item.variantId) ?? [];
    variantGroup.push(item);
    variants.set(item.variantId, variantGroup);
  }

  return [...variants.values()]
    .map((variantGroup) => {
      const representative =
        concreteSaleableItem(variantGroup) ?? variantGroup[0];
      const saleReadyItems = variantGroup.filter(
        (item) => item.slotSalesState === "sale_ready",
      );
      const saleableStock = saleReadyItems.reduce(
        (sum, item) => sum + item.saleableStock,
        0,
      );
      const physicalStock = variantGroup.reduce(
        (sum, item) => sum + item.physicalStock,
        0,
      );
      const capacity = variantGroup.reduce(
        (sum, item) => sum + item.capacity,
        0,
      );
      const parLevel = variantGroup.reduce(
        (sum, item) => sum + item.parLevel,
        0,
      );
      return {
        variantId: representative.variantId,
        sku: representative.sku,
        size: representative.size,
        color: representative.color,
        priceCents: representative.priceCents,
        tryOnSilhouetteUrl: representative.tryOnSilhouetteUrl ?? null,
        capacity,
        parLevel,
        physicalStock,
        saleableStock,
        slotSalesState:
          saleableStock > 0 && saleReadyItems.length > 0
            ? "sale_ready"
            : representative.slotSalesState,
        slotCandidates: variantGroup.flatMap((item) => item.slotCandidates),
      };
    })
    .sort(
      (a, b) =>
        sizeRank(a.size) - sizeRank(b.size) ||
        (a.color ?? "").localeCompare(b.color ?? "") ||
        a.priceCents - b.priceCents ||
        a.sku.localeCompare(b.sku),
    );
}

function aggregateCatalogItems(
  items: MachineCatalogItem[],
): MachineCatalogItem[] {
  const groups = new Map<string, MachineCatalogItem[]>();
  for (const item of items) {
    const group = groups.get(item.catalogKey) ?? [];
    group.push(item);
    groups.set(item.catalogKey, group);
  }

  return [...groups.values()]
    .map((group) => {
      const representative = concreteSaleableItem(group) ?? group[0];
      const saleReadyItems = group.filter(
        (item) => item.slotSalesState === "sale_ready",
      );
      const variantCandidates = aggregateVariantCandidates(group);
      const saleableStock = saleReadyItems.reduce(
        (sum, item) => sum + item.saleableStock,
        0,
      );
      const physicalStock = group.reduce(
        (sum, item) => sum + item.physicalStock,
        0,
      );
      const capacity = group.reduce((sum, item) => sum + item.capacity, 0);
      const parLevel = group.reduce((sum, item) => sum + item.parLevel, 0);

      return {
        ...representative,
        priceCents:
          variantCandidates.find(
            (candidate) =>
              candidate.slotSalesState === "sale_ready" &&
              candidate.saleableStock > 0,
          )?.priceCents ?? representative.priceCents,
        physicalStock,
        saleableStock,
        capacity,
        parLevel,
        slotSalesState:
          saleableStock > 0 && saleReadyItems.length > 0
            ? "sale_ready"
            : representative.slotSalesState,
        aggregatedSlotCount: group.length,
        slotCandidates: group.flatMap((item) => item.slotCandidates),
        variantCandidates,
      };
    })
    .sort(
      (a, b) =>
        a.productSortOrder - b.productSortOrder ||
        a.layerNo - b.layerNo ||
        a.cellNo - b.cellNo ||
        a.productName.localeCompare(b.productName),
    );
}

export const useCatalogStore = defineStore("catalog", {
  state: () => ({
    items: [] as MachineCatalogItem[],
    cachedOnly: false,
    source: "uninitialized",
    planogramVersion: null as string | null,
    lastUpdatedAt: null as string | null,
    loading: false,
    error: null as string | null,
    mediaDiagnostics: [] as CatalogMediaDiagnostic[],
    operatorDiagnostics: [] as CatalogOperatorDiagnostic[],
    autoRefreshEnabled: false,
  }),
  getters: {
    availableItems: (state): MachineCatalogItem[] =>
      aggregateCatalogItems(state.items).filter(
        (item) =>
          item.slotSalesState === "sale_ready" && item.saleableStock > 0,
      ),
    hasItems: (state): boolean => state.items.length > 0,
    itemByInventoryId:
      (state) =>
      (inventoryId: string): MachineCatalogItem | undefined =>
        state.items.find((item) =>
          item.slotCandidates.some(
            (candidate) => candidate.inventoryId === inventoryId,
          ),
        ),
    itemByCatalogKey:
      (state) =>
      (catalogKey: string): MachineCatalogItem | undefined =>
        aggregateCatalogItems(state.items).find(
          (item) => item.catalogKey === catalogKey,
        ),
    saleableVariantItemFor:
      (state) =>
      (catalogKey: string, variantId: string): MachineCatalogItem | null =>
        concreteSaleableItem(
          state.items.filter((item) => item.catalogKey === catalogKey),
          variantId,
        ),
    saleableItemFor:
      (state) =>
      (selectedItem: MachineCatalogItem): MachineCatalogItem | null => {
        const candidates = state.items.filter(
          (item) =>
            item.catalogKey === selectedItem.catalogKey &&
            item.variantId === selectedItem.variantId,
        );
        return concreteSaleableItem(candidates);
      },
  },
  actions: {
    applySnapshot(snapshot: {
      items: MachineSaleViewItem[];
      cached?: boolean;
      source: string;
      planogramVersion?: string | null;
      lastUpdatedAt: string | null;
      lastError?: string | null;
      mediaDiagnostics?: readonly SaleViewMediaDiagnostic[];
    }): void {
      this.items = snapshot.items.map((item) => asCatalogItem(item));
      this.cachedOnly = snapshot.cached ?? false;
      this.source = snapshot.source;
      this.planogramVersion = snapshot.planogramVersion ?? null;
      this.lastUpdatedAt = snapshot.lastUpdatedAt;
      this.error = snapshot.lastError ?? null;
      for (const diagnostic of snapshot.mediaDiagnostics ?? []) {
        this.recordMediaDiagnostic(
          diagnostic.reference,
          diagnostic.message,
          diagnostic.diagnosticKey,
        );
      }
    },
    recordMediaDiagnostic(
      reference: string | null | undefined,
      message: string,
      diagnosticKey = mediaDiagnosticKey(reference),
    ): void {
      if (
        this.mediaDiagnostics.some(
          (diagnostic) => diagnostic.diagnosticKey === diagnosticKey,
        )
      ) {
        return;
      }
      this.mediaDiagnostics = [
        ...this.mediaDiagnostics.slice(-19),
        {
          reference: reference ?? null,
          diagnosticKey,
          message,
          recordedAt: new Date().toISOString(),
        },
      ];
      this.recordCatalogDiagnostic("media", reference, message, diagnosticKey);
    },
    recordCatalogDiagnostic(
      kind: CatalogOperatorDiagnostic["kind"],
      reference: string | null | undefined,
      message: string,
      diagnosticKey = `${kind}:${reference ?? "missing"}`,
    ): void {
      const normalizedReference = reference ?? null;
      if (
        this.operatorDiagnostics.some(
          (diagnostic) => diagnostic.diagnosticKey === diagnosticKey,
        )
      ) {
        return;
      }
      this.operatorDiagnostics = [
        ...this.operatorDiagnostics.slice(-19),
        {
          kind,
          reference: normalizedReference,
          diagnosticKey,
          message,
          recordedAt: new Date().toISOString(),
        },
      ];
    },
    async load(): Promise<void> {
      await this.refresh();
    },
    async refresh(): Promise<void> {
      if (refreshInFlight) return refreshInFlight;
      this.loading = true;
      refreshInFlight = (async () => {
        this.applySnapshot(await daemonClient.getSaleView());
        this.error = null;
        this.loading = false;
        refreshInFlight = null;
      })();
      try {
        await refreshInFlight;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.loading = false;
        refreshInFlight = null;
        throw error;
      }
    },
    startAutoRefresh(intervalMs = DEFAULT_AUTO_REFRESH_INTERVAL_MS): void {
      autoRefreshConsumers += 1;
      this.autoRefreshEnabled = true;
      void this.refresh().catch(() => undefined);
      if (autoRefreshTimer !== null) return;
      autoRefreshTimer = setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, intervalMs);
    },
    stopAutoRefresh(): void {
      autoRefreshConsumers = Math.max(0, autoRefreshConsumers - 1);
      if (autoRefreshConsumers > 0) return;
      this.autoRefreshEnabled = false;
      if (autoRefreshTimer !== null) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    },
  },
});
