export type MachineCatalogItem = {
  machineCode: string;
  slotId: string;
  slotCode: string;
  layerNo: number;
  cellNo: number;
  inventoryId: string;
  variantId: string;
  productName: string;
  sku: string;
  size: string | null;
  color: string | null;
  priceCents: number;
  availableQty: number;
};
