import { defineStore } from "pinia";

import type { MachineCatalogItem, MachineSaleViewItem } from "@/types/catalog";

import { daemonClient } from "@/daemon/client";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 5_000;

let refreshInFlight: Promise<void> | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshConsumers = 0;

function catalogKeyFor(item: Pick<MachineSaleViewItem, "sku">): string {
  return `sku:${item.sku}`;
}

function asCatalogItem(
  item: MachineSaleViewItem,
  slotCandidates = [item],
): MachineCatalogItem {
  return {
    ...item,
    catalogKey: catalogKeyFor(item),
    aggregatedSlotCount: slotCandidates.length,
    slotCandidates: slotCandidates.map((candidate) => ({
      slotId: candidate.slotId,
      slotCode: candidate.slotCode,
      layerNo: candidate.layerNo,
      cellNo: candidate.cellNo,
      inventoryId: candidate.inventoryId,
      capacity: candidate.capacity,
      parLevel: candidate.parLevel,
      physicalStock: candidate.physicalStock,
      saleableStock: candidate.saleableStock,
      slotSalesState: candidate.slotSalesState,
    })),
  };
}

function concreteSaleableItem(
  items: MachineCatalogItem[],
): MachineCatalogItem | null {
  const candidates = items
    .filter(
      (item) => item.slotSalesState === "sale_ready" && item.saleableStock > 0,
    )
    .sort(
      (a, b) =>
        a.productSortOrder - b.productSortOrder ||
        a.layerNo - b.layerNo ||
        a.cellNo - b.cellNo ||
        a.slotCode.localeCompare(b.slotCode),
    );
  return candidates[0] ?? null;
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
        aggregateCatalogItems(state.items).find((item) =>
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
    saleableItemFor:
      (state) =>
      (selectedItem: MachineCatalogItem): MachineCatalogItem | null => {
        const candidates = state.items.filter(
          (item) => item.catalogKey === selectedItem.catalogKey,
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
    }): void {
      this.items = snapshot.items.map((item) => asCatalogItem(item));
      this.cachedOnly = snapshot.cached ?? false;
      this.source = snapshot.source;
      this.planogramVersion = snapshot.planogramVersion ?? null;
      this.lastUpdatedAt = snapshot.lastUpdatedAt;
      this.error = snapshot.lastError ?? null;
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
