import type { MachineSaleViewItem } from "@vem/shared";

export type MachineCatalogSlotCandidate = Pick<
  MachineSaleViewItem,
  | "slotId"
  | "slotCode"
  | "layerNo"
  | "cellNo"
  | "inventoryId"
  | "capacity"
  | "parLevel"
  | "physicalStock"
  | "saleableStock"
  | "slotSalesState"
>;

export type MachineCatalogItem = MachineSaleViewItem & {
  catalogKey: string;
  aggregatedSlotCount: number;
  slotCandidates: readonly MachineCatalogSlotCandidate[];
};

export type { MachineSaleViewItem };

/** Recommendation engine output: item + score + reason */
export type ScoredItem = MachineCatalogItem & {
  score: number;
  reason: string;
};
