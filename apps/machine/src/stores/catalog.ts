import type {
  MachineRecommendationItem,
  MachineRecommendationRequest,
  VisionProfile,
} from "@vem/shared";

import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";
import type { MachineCatalogItem } from "@/types/catalog";

import { getMachineCatalog } from "@/api/catalog";
import { getMachineRecommendations } from "@/api/recommendations";
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

function heightRangeFromCm(heightCm: number | undefined): string | undefined {
  if (!heightCm) return undefined;
  if (heightCm < 155) return "petite";
  if (heightCm < 170) return "regular";
  if (heightCm < 185) return "tall";
  return "extra_tall";
}

function recommendationProfileFromVision(
  profile: VisionProfile,
): MachineRecommendationRequest["profileSnapshot"] {
  return {
    ageRange: profile.ageRange,
    gender: profile.gender,
    heightRange: heightRangeFromCm(profile.heightCm),
    bodyType: profile.bodyType,
  };
}

export const useCatalogStore = defineStore("catalog", {
  state: () => ({
    items: [] as MachineCatalogItem[],
    recommendations: [] as MachineRecommendationItem[],
    recommendationProfile: null as VisionProfile | null,
    recommendationLoading: false,
    recommendationError: null as string | null,
    recommendationUpdatedAt: null as number | null,
    cachedOnly: false,
    lastUpdatedAt: null as number | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    availableItems: (state): MachineCatalogItem[] =>
      state.items.filter((item) => item.availableQty > 0),
    recommendedAvailableItems: (state): MachineRecommendationItem[] =>
      state.recommendations.filter((item) => item.availableQty > 0),
    hasRecommendations: (state): boolean => state.recommendations.length > 0,
    hasItems: (state): boolean => state.items.length > 0,
    itemByInventoryId:
      (state) =>
      (inventoryId: string): MachineCatalogItem | undefined =>
        state.items.find((item) => item.inventoryId === inventoryId),
  },
  actions: {
    clearRecommendations(): void {
      this.recommendations = [];
      this.recommendationProfile = null;
      this.recommendationError = null;
      this.recommendationUpdatedAt = null;
    },
    loadCached(machineCode: string): void {
      this.items = readCachedCatalog(machineCode);
      this.clearRecommendations();
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
        this.clearRecommendations();
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
    async refreshRecommendations(
      config: MachineConfig,
      profile: VisionProfile,
    ): Promise<void> {
      if (!config.machineCode) throw new Error("machineCode missing");
      if (!profile.personPresent) throw new Error("视觉模块未检测到用户");

      this.recommendationLoading = true;
      this.recommendationError = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const recommendations = await getMachineRecommendations(
          client,
          config.machineCode,
          {
            profileSnapshot: recommendationProfileFromVision(profile),
            limit: 8,
          },
        );
        this.recommendations = recommendations;
        this.recommendationProfile = profile;
        this.recommendationUpdatedAt = Date.now();
      } catch (error) {
        this.recommendationError =
          error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.recommendationLoading = false;
      }
    },
  },
});
