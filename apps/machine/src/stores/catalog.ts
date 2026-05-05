import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";
import type { MachineCatalogItem } from "@/types/catalog";

import { getMachineCatalog } from "@/api/catalog";
import { createMachineApiClient } from "@/api/request";

function cacheKey(machineCode: string): string {
  return `vem.machine.catalog.${machineCode}`;
}

function isCatalogItem(val: unknown): val is MachineCatalogItem {
  return typeof val === "object" && val !== null && "inventoryId" in val;
}

function readCachedCatalog(machineCode: string): MachineCatalogItem[] {
  const raw = localStorage.getItem(cacheKey(machineCode));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCatalogItem);
  } catch {
    return [];
  }
}

function writeCachedCatalog(
  machineCode: string,
  items: MachineCatalogItem[],
): void {
  localStorage.setItem(cacheKey(machineCode), JSON.stringify(items));
}

export const useCatalogStore = defineStore("catalog", {
  state: () => ({
    items: [] as MachineCatalogItem[],
    cachedOnly: false,
    lastUpdatedAt: null as number | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    availableItems: (state): MachineCatalogItem[] =>
      state.items.filter((item) => item.availableQty > 0),
    hasItems: (state): boolean => state.items.length > 0,
    itemByInventoryId:
      (state) =>
      (inventoryId: string): MachineCatalogItem | undefined =>
        state.items.find((item) => item.inventoryId === inventoryId),
  },
  actions: {
    loadCached(machineCode: string): void {
      this.items = readCachedCatalog(machineCode);
      this.cachedOnly = true;
      this.lastUpdatedAt = null;
    },
    async refresh(config: MachineConfig): Promise<void> {
      if (!config.machineCode) {
        this.items = [];
        this.error = "machineCode missing";
        return;
      }

      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const items = await getMachineCatalog(client, config.machineCode);
        this.items = items;
        this.cachedOnly = false;
        this.lastUpdatedAt = Date.now();
        writeCachedCatalog(config.machineCode, items);
      } catch (error) {
        this.loadCached(config.machineCode);
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
  },
});
