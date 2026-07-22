export const catalogTopCategories = Object.freeze([
  Object.freeze({
    key: "socks",
    label: "袜子",
    description: "中筒袜、船袜、运动袜",
    categoryKeywords: Object.freeze(["袜"]),
    productKeywords: Object.freeze(["袜"]),
  }),
  Object.freeze({
    key: "underwear",
    label: "内裤",
    description: "平角裤、无痕内裤、贴身基础款",
    categoryKeywords: Object.freeze(["内衣", "内裤"]),
    productKeywords: Object.freeze(["内裤", "平角裤", "文胸", "打底", "内衣"]),
  }),
  Object.freeze({
    key: "tshirts",
    label: "T恤",
    description: "短袖、背心、轻量上装",
    categoryKeywords: Object.freeze(["t恤", "上装", "运动服", "短袖"]),
    productKeywords: Object.freeze(["t恤", "t 恤", "短袖", "背心"]),
  }),
]);

function normalizeText(value) {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, "");
}

function includesAny(value, keywords) {
  return keywords.some((keyword) => value.includes(normalizeText(keyword)));
}

export function topCategoryForCatalogItem(item) {
  const categoryName = normalizeText(item?.categoryName);
  const productName = normalizeText(item?.productName);
  return (
    catalogTopCategories.find(
      (category) =>
        includesAny(categoryName, category.categoryKeywords) ||
        includesAny(productName, category.productKeywords),
    ) ?? null
  );
}

export function topCategoryKeyForCatalogItem(item) {
  return topCategoryForCatalogItem(item)?.key ?? null;
}
