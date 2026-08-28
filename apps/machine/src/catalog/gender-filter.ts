import type { MachineCatalogItem } from "@/types/catalog";

export type ProductGenderFilter = "all" | "male" | "female" | "kids" | "elder";

export function genderForItem(item: MachineCatalogItem): ProductGenderFilter {
  const text = `${item.productName} ${item.categoryName ?? ""}`;
  // 年龄群体优先于性别：童装/老年商品同时带有 targetGender，
  // 必须先按名称识别年龄，否则会被性别分支提前吞掉。
  if (text.includes("儿童") || text.includes("童")) return "kids";
  if (text.includes("老年") || text.includes("老人")) return "elder";
  if (item.targetGender === "male" || item.targetGender === "female") {
    return item.targetGender;
  }
  return "all";
}

export function genderLabelForFilter(filter: ProductGenderFilter): string {
  if (filter === "male") return "男款";
  if (filter === "female") return "女款";
  if (filter === "kids") return "儿童";
  if (filter === "elder") return "老人";
  return "通用";
}
