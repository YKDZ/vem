import type { z } from "zod";

import {
  managedMediaLoopbackUrlSchema,
  visionV2GarmentSourceSchema,
  visionV2ResultReferenceSchema,
} from "@vem/shared";

import type { MachineCatalogItem } from "@/types/catalog";

type VisionV2GarmentSource = z.infer<typeof visionV2GarmentSourceSchema>;
type VisionV2ResultReference = z.infer<typeof visionV2ResultReferenceSchema>;

export type VisionFastReadiness = {
  fastReady: boolean;
  visionBusinessReady: boolean;
};

/** The platform's active association is represented by a valid garment descriptor. */
export function canStartFastTryOn(
  item: MachineCatalogItem | null | undefined,
  readiness: VisionFastReadiness,
): boolean {
  if (!item || !readiness.fastReady || !readiness.visionBusinessReady) {
    return false;
  }
  if (!isTshirt(item.categoryName) || item.slotSalesState !== "sale_ready") {
    return false;
  }
  const media = item.tryOnGarmentMedia;
  if (!media || media.purpose !== "try_on_garment") return false;
  if (media.contentType !== "image/png") return false;
  return isReadyLoopbackMediaUrl(item.tryOnGarmentReadyUrl);
}

export function visionGarmentSourceFor(
  item: MachineCatalogItem,
): VisionV2GarmentSource {
  const media = item.tryOnGarmentMedia;
  if (!media) {
    throw new Error("try-on garment is not eligible");
  }
  const readyUrl = item.tryOnGarmentReadyUrl;
  if (!readyUrl || !isReadyLoopbackMediaUrl(readyUrl)) {
    throw new Error("try-on garment media is not ready");
  }
  // The daemon grant is an opaque read credential. V2 intentionally carries
  // it in the generated contract's token field without exposing the grant in
  // any durable Machine state or diagnostics.
  const url = new URL(readyUrl);
  const credential =
    url.searchParams.get("token") ?? url.searchParams.get("grant");
  if (!credential) throw new Error("try-on garment media grant is missing");
  url.search = `?token=${credential}`;
  return visionV2GarmentSourceSchema.parse({
    assetId: media.id,
    reference: url.toString(),
    digest: media.digest,
    contentType: media.contentType,
    byteSize: media.byteSize,
    template: item.tryOnGarmentTemplate ?? "tshirt_short_sleeve",
  });
}

export function validateTryOnResultReference(
  value: unknown,
): VisionV2ResultReference {
  const parsed = visionV2ResultReferenceSchema.parse(value);
  const url = new URL(parsed.reference);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    !/^\/results\/[A-Za-z0-9._-]+$/.test(url.pathname) ||
    url.pathname.includes("%") ||
    url.searchParams.get("token") === null ||
    url.searchParams.size !== 1
  ) {
    throw new Error("Vision returned an unsafe try-on result reference");
  }
  return parsed;
}

function isTshirt(categoryName: string | null): boolean {
  if (!categoryName) return false;
  const normalized = categoryName.trim().toLowerCase();
  return (
    normalized === "t恤" || normalized === "t-shirt" || normalized === "tshirt"
  );
}

function isReadyLoopbackMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
        url.hostname.toLowerCase(),
      )
    ) {
      return false;
    }
    managedMediaLoopbackUrlSchema.parse(value);
    return true;
  } catch {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
          url.hostname.toLowerCase(),
        ) &&
        url.pathname.startsWith("/media/") &&
        (url.searchParams.has("token") || url.searchParams.has("grant")) &&
        url.searchParams.size === 1
      );
    } catch {
      return false;
    }
  }
}
