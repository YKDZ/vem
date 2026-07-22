export type CatalogTopCategoryKey = "socks" | "underwear" | "tshirts";

export type CatalogTopCategory = {
  key: CatalogTopCategoryKey;
  label: string;
  description: string;
  categoryKeywords: readonly string[];
  productKeywords: readonly string[];
};

export type CatalogCategoryCandidate = {
  categoryName?: string | null;
  productName?: string | null;
};

export const catalogTopCategories: readonly CatalogTopCategory[];

export function topCategoryForCatalogItem(
  item: CatalogCategoryCandidate,
): CatalogTopCategory | null;

export function topCategoryKeyForCatalogItem(
  item: CatalogCategoryCandidate,
): CatalogTopCategoryKey | null;
