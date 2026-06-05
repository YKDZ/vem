import type { MachineSaleViewItem } from "@vem/shared";

export type MachineCatalogItem = MachineSaleViewItem;
export type { MachineSaleViewItem };

/** Recommendation engine output: item + score + reason */
export type ScoredItem = MachineCatalogItem & {
  score: number;
  reason: string;
};
