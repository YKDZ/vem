import type { MachineCatalogItem } from "@vem/shared";

export type { MachineCatalogItem };

/** Recommendation engine output: item + score + reason */
export type ScoredItem = MachineCatalogItem & {
  score: number;
  reason: string;
};
