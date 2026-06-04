import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import { daemonClient } from "@/daemon/client";

export const useCatalogStore = defineStore("catalog", {
  state: () => ({
    items: [] as MachineCatalogItem[],
    cachedOnly: false,
    source: "uninitialized",
    lastUpdatedAt: null as string | null,
    loading: false,
    error: null as string | null,
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
      lastUpdatedAt: string | null;
      lastError?: string | null;
    }): void {
      this.items = snapshot.items;
      this.cachedOnly = snapshot.cached ?? false;
      this.source = snapshot.source;
      this.lastUpdatedAt = snapshot.lastUpdatedAt;
      this.error = snapshot.lastError ?? null;
    },
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.applySnapshot(await daemonClient.getSaleView());
      } finally {
        this.loading = false;
      }
    },
    async refresh(): Promise<void> {
      this.loading = true;
      try {
        this.applySnapshot(await daemonClient.getSaleView());
      } finally {
        this.loading = false;
      }
    },
  },
});
