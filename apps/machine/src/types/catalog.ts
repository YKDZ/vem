import type { MachineSaleViewItem } from "@vem/shared";

export type MachineCatalogSlotCandidate = Pick<
  MachineSaleViewItem,
  | "slotId"
  | "slotDisplayLabel"
  | "rowNo"
  | "cellNo"
  | "inventoryId"
  | "variantId"
  | "sku"
  | "size"
  | "color"
  | "priceCents"
  | "capacity"
  | "parLevel"
  | "physicalStock"
  | "saleableStock"
  | "slotSalesState"
>;

export type MachineCatalogVariantCandidate = Pick<
  MachineSaleViewItem,
  "variantId" | "sku" | "size" | "color" | "priceCents" | "tryOnSilhouetteUrl"
> & {
  capacity: number;
  parLevel: number;
  physicalStock: number;
  saleableStock: number;
  slotSalesState: MachineSaleViewItem["slotSalesState"];
  slotCandidates: readonly MachineCatalogSlotCandidate[];
};

export type MachineCatalogItem = MachineSaleViewItem & {
  catalogKey: string;
  aggregatedSlotCount: number;
  slotCandidates: readonly MachineCatalogSlotCandidate[];
  variantCandidates: readonly MachineCatalogVariantCandidate[];
};

export type { MachineSaleViewItem };
