import type { VisionProfile } from "@vem/shared";

import type { MachineCatalogItem, ScoredItem } from "@/types/catalog";

/** Standard size order array, used for adjacent size calculation. */
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL"] as const;

/**
 * Infer user's fitting size based on heightCm + bodyType.
 * Mapping per spec scoring table:
 *   - heightCm < 165: slim/regular→S, strong→M
 *   - 165-175:        slim/regular→M, strong→L
 *   - 175-185:        slim/regular→L, strong→XL
 *   - > 185:          all→XL
 * Returns null if heightCm is undefined (skip size scoring).
 */
export function inferSize(
  heightCm: number | undefined,
  bodyType: string | undefined,
): string | null {
  if (heightCm === undefined) {
    return null;
  }
  const isStrong = bodyType === "strong";
  if (heightCm < 165) {
    return isStrong ? "M" : "S";
  }
  if (heightCm < 175) {
    return isStrong ? "L" : "M";
  }
  if (heightCm < 185) {
    return isStrong ? "XL" : "L";
  }
  return "XL";
}

/**
 * Returns the index of a size in SIZE_ORDER, -1 if not found.
 */
function sizeRank(size: string): number {
  return SIZE_ORDER.indexOf(size as unknown as (typeof SIZE_ORDER)[number]);
}

/**
 * Calculate size score based on user's inferred size vs item size.
 * - Exact match: +50
 * - Adjacent (|rank diff| === 1): +25
 * - Other or userSize is null: +0
 */
function computeSizeScore(
  userSize: string | null,
  itemSize: string | null,
): number {
  if (userSize === null || itemSize === null) {
    return 0;
  }
  const userRank = sizeRank(userSize);
  const itemRank = sizeRank(itemSize);
  if (userRank < 0 || itemRank < 0) {
    return 0;
  }
  if (userRank === itemRank) {
    return 50;
  }
  if (Math.abs(userRank - itemRank) === 1) {
    return 25;
  }
  return 0;
}

/**
 * Stock weight: min(availableQty, 10)
 */
function computeStockScore(availableQty: number): number {
  return Math.min(availableQty, 10);
}

/**
 * Sort fallback weight: max(0, 10 - productSortOrder)
 */
function computeSortScore(productSortOrder: number): number {
  return Math.max(0, 10 - productSortOrder);
}

/**
 * Gender hard filter per spec:
 * - profile.gender is not "unknown" + item.targetGender is not null + they conflict → return false (exclude)
 * - profile.gender === "unknown" or item.targetGender === null → don't filter
 * Returns false to indicate the item should be excluded.
 */
function checkGenderFilter(
  profileGender: string | undefined,
  itemTargetGender: string | null | undefined,
): boolean {
  // If profile gender is unknown, don't filter
  if (profileGender === undefined || profileGender === "unknown") {
    return true;
  }
  // If item has no target gender, don't filter
  if (itemTargetGender === undefined || itemTargetGender === null) {
    return true;
  }
  // If target genders match, don't filter
  if (profileGender === itemTargetGender) {
    return true;
  }
  // Genders conflict
  return false;
}

/**
 * Score a single item:
 * 1. Call checkGenderFilter, exclude if returns false
 * 2. Accumulate sizeScore + stockScore + sortScore
 * 3. Generate reason text based on sizeScore
 * Returns null if item is filtered out by gender.
 */
export function scoreItem(
  profile: VisionProfile,
  item: MachineCatalogItem,
): { score: number; reason: string } | null {
  // Gender hard filter
  if (!checkGenderFilter(profile.gender, item.targetGender)) {
    return null;
  }

  const userSize = inferSize(profile.heightCm ?? undefined, profile.bodyType);
  const sizeScore = computeSizeScore(userSize, item.size ?? null);
  const stockScore = computeStockScore(item.availableQty);
  const sortScore = computeSortScore(item.productSortOrder);

  const totalScore = sizeScore + stockScore + sortScore;

  // Generate reason
  let reason = "";
  if (sizeScore === 50) {
    reason = "尺码正好";
  } else if (sizeScore === 25) {
    reason = "尺码相近";
  } else {
    reason = "可选";
  }

  return { score: totalScore, reason };
}

/**
 * Main entry: receive vision profile + item list, output top 6 recommendations.
 * 1. Call scoreItem for each item, filter out nulls
 * 2. Sort by score descending
 * 3. Take top 6, map to ScoredItem
 */
export function computeRecommendations(
  profile: VisionProfile,
  items: MachineCatalogItem[],
): ScoredItem[] {
  const scored = items
    .map((item) => {
      const scored = scoreItem(profile, item);
      if (scored === null) return null;
      return { ...item, ...scored };
    })
    .filter((result): result is ScoredItem => result !== null);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 6);
}
