import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import { daemonClient } from "@/daemon/client";

const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 5_000;

let refreshInFlight: Promise<void> | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshConsumers = 0;

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
      state.items.filter(
        (item) =>
          item.slotSalesState === "sale_ready" && item.saleableStock > 0,
      ),
    hasItems: (state): boolean => state.items.length > 0,
    itemByInventoryId:
      (state) =>
      (inventoryId: string): MachineCatalogItem | undefined =>
        state.items.find((item) => item.inventoryId === inventoryId),
  },
  actions: {
    applySnapshot(snapshot: {
      items: MachineCatalogItem[];
      cached?: boolean;
      source: string;
      planogramVersion?: string | null;
      lastUpdatedAt: string | null;
      lastError?: string | null;
    }): void {
      this.items = snapshot.items;
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
