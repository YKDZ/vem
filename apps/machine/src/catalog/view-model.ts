import type { MachineCatalogItem } from "@/types/catalog";

export type CatalogTopCategoryKey = "socks" | "underwear" | "tshirts";

export type CatalogTopCategory = {
  key: CatalogTopCategoryKey;
  label: string;
  description: string;
  categoryKeywords: readonly string[];
  productKeywords: readonly string[];
};

export type CatalogTopCategoryGroup = CatalogTopCategory & {
  items: MachineCatalogItem[];
  saleableStock: number;
};

export type CatalogSubcategoryGroup = {
  key: string;
  label: string;
  items: MachineCatalogItem[];
};

export const catalogTopCategories: readonly CatalogTopCategory[] = [
  {
    key: "socks",
    label: "袜子",
    description: "中筒袜、船袜、运动袜",
    categoryKeywords: ["袜"],
    productKeywords: ["袜"],
  },
  {
    key: "underwear",
    label: "内裤",
    description: "平角裤、无痕内裤、贴身基础款",
    categoryKeywords: ["内衣", "内裤"],
    productKeywords: ["内裤", "平角裤", "文胸", "打底", "内衣"],
  },
  {
    key: "tshirts",
    label: "T恤",
    description: "短袖、背心、轻量上装",
    categoryKeywords: ["t恤", "上装", "运动服", "短袖"],
    productKeywords: ["t恤", "t 恤", "短袖", "背心"],
  },
];

const FALLBACK_SUBCATEGORY_KEY = "uncategorized";

function sortCatalogItems(items: MachineCatalogItem[]): MachineCatalogItem[] {
  return [...items].sort(
    (a, b) =>
      a.productSortOrder - b.productSortOrder ||
      a.productName.localeCompare(b.productName),
  );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, "");
}

function includesAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(normalizeText(keyword)));
}

function matchingTopCategory(
  item: Pick<MachineCatalogItem, "categoryName" | "productName">,
): CatalogTopCategory | null {
  const categoryName = normalizeText(item.categoryName);
  const productName = normalizeText(item.productName);
  return (
    catalogTopCategories.find(
      (category) =>
        includesAny(categoryName, category.categoryKeywords) ||
        includesAny(productName, category.productKeywords),
    ) ?? null
  );
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
