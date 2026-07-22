import type { MachineCatalogItem } from "@/types/catalog";
import {
  catalogTopCategories,
  topCategoryForCatalogItem,
  type CatalogTopCategory,
  type CatalogTopCategoryKey,
} from "@vem/shared/catalog-top-category";

export { catalogTopCategories };
export type { CatalogTopCategory, CatalogTopCategoryKey };

export type CatalogTopCategoryGroup = CatalogTopCategory & {
  items: MachineCatalogItem[];
  saleableStock: number;
};

export type CatalogSubcategoryGroup = {
  key: string;
  label: string;
  items: MachineCatalogItem[];
};

const FALLBACK_SUBCATEGORY_KEY = "uncategorized";

function sortCatalogItems(items: MachineCatalogItem[]): MachineCatalogItem[] {
  return [...items].sort(
    (a, b) =>
      a.productSortOrder - b.productSortOrder ||
      a.productName.localeCompare(b.productName),
  );
}

function matchingTopCategory(
  item: Pick<MachineCatalogItem, "categoryName" | "productName">,
): CatalogTopCategory | null {
  return topCategoryForCatalogItem(item);
}

export function usesFallbackTopCategory(
  item: Pick<MachineCatalogItem, "categoryName" | "productName">,
): boolean {
  return matchingTopCategory(item) === null;
}

export function topCategoryForItem(
  item: Pick<MachineCatalogItem, "categoryName" | "productName">,
): CatalogTopCategory | null {
  return matchingTopCategory(item);
}

export function groupItemsByTopCategory(
  items: readonly MachineCatalogItem[],
): CatalogTopCategoryGroup[] {
  return catalogTopCategories.map((category) => {
    const categoryItems = sortCatalogItems(
      items.filter((item) => topCategoryForItem(item)?.key === category.key),
    );
    return {
      ...category,
      items: categoryItems,
      saleableStock: categoryItems.reduce(
        (sum, item) => sum + item.saleableStock,
        0,
      ),
    };
  });
}

export function subcategoryKeyForItem(item: MachineCatalogItem): string {
  return item.categoryId ?? item.categoryName ?? FALLBACK_SUBCATEGORY_KEY;
}

export function subcategoryLabelForItem(item: MachineCatalogItem): string {
  return item.categoryName ?? "其他商品";
}

export function groupSubcategories(
  items: readonly MachineCatalogItem[],
): CatalogSubcategoryGroup[] {
  const groups = new Map<string, CatalogSubcategoryGroup>();

  for (const item of items) {
    const key = subcategoryKeyForItem(item);
    const current = groups.get(key);
    if (current) {
      current.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      label: subcategoryLabelForItem(item),
      items: [item],
    });
  }

  return [...groups.values()]
    .map((group) => ({ ...group, items: sortCatalogItems(group.items) }))
    .sort((a, b) => {
      const aSort = Math.min(...a.items.map((item) => item.productSortOrder));
      const bSort = Math.min(...b.items.map((item) => item.productSortOrder));
      return aSort - bSort || a.label.localeCompare(b.label);
    });
}

export function firstItemInGroups(
  groups: readonly CatalogSubcategoryGroup[],
): MachineCatalogItem | null {
  return groups[0]?.items[0] ?? null;
}
