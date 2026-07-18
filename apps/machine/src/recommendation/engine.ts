import type { VisionProfile } from "@vem/shared";

import type { MachineCatalogVariantCandidate } from "@/types/catalog";

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

function variantIsSaleable(variant: MachineCatalogVariantCandidate): boolean {
  return variant.slotSalesState === "sale_ready" && variant.saleableStock > 0;
}

function defaultVariant(
  variants: readonly MachineCatalogVariantCandidate[],
): MachineCatalogVariantCandidate | null {
  return variants.find(variantIsSaleable) ?? variants[0] ?? null;
}

function normalizeAttribute(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, "");
}

function matchesColor(
  variant: MachineCatalogVariantCandidate,
  preferredColor: string | undefined,
): boolean {
  const color = normalizeAttribute(variant.color);
  const preferred = normalizeAttribute(preferredColor);
  return Boolean(color && preferred && color.includes(preferred));
}

export type VariantRecommendation = {
  variant: MachineCatalogVariantCandidate | null;
  score: number;
};

/**
 * Recommend one variant and expose only whether Vision actually improved the
 * deterministic catalog fallback. Catalog ordering can consume the score
 * without becoming a second selection authority.
 */
export function recommendVariant(
  variants: readonly MachineCatalogVariantCandidate[],
  profile?: VisionProfile | null,
): VariantRecommendation {
  const fallback = defaultVariant(variants);
  if (!fallback) return { variant: null, score: 0 };

  const inferredSize = inferSize(
    profile?.heightCm ?? undefined,
    profile?.bodyType,
  );
  const hasSizeMatch = Boolean(
    inferredSize && variants.some((variant) => variant.size === inferredSize),
  );
  const size = hasSizeMatch ? inferredSize : fallback.size;
  const sizePool = variants.filter((variant) => variant.size === size);
  const scopedFallback = defaultVariant(sizePool) ?? fallback;
  const colorMatch = sizePool.find((variant) =>
    matchesColor(variant, profile?.upperColor),
  );

  return {
    variant: colorMatch ?? scopedFallback,
    score: (hasSizeMatch ? 2 : 0) + (colorMatch ? 1 : 0),
  };
}

/**
 * Pick the initial product variant silently from a vision profile.
 * Missing or unmatched signals fall back to the catalog's deterministic default.
 */
export function choosePreferredVariant(
  variants: readonly MachineCatalogVariantCandidate[],
  profile?: VisionProfile | null,
): MachineCatalogVariantCandidate | null {
  return recommendVariant(variants, profile).variant;
}
