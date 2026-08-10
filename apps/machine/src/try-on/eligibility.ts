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

export type VisionTryOnResultContext = {
  attemptId: string;
  /** The exact socket endpoint that accepted this attempt. */
  visionSocketUrl: string;
};

/** The platform's active association is represented by a valid garment descriptor. */
export function canStartFastTryOn(
  item: MachineCatalogItem | null | undefined,
  readiness: VisionFastReadiness,
): boolean {
  if (!item || !readiness.fastReady || !readiness.visionBusinessReady) {
    return false;
  }
  if (item.slotSalesState !== "sale_ready") {
    return false;
  }
  const media = item.tryOnGarmentMedia;
  if (!media || media.purpose !== "try_on_garment") return false;
  if (media.contentType !== "image/png") return false;
  if (
    item.tryOnGarmentTemplate !== "tshirt_short_sleeve" &&
    item.tryOnGarmentTemplate !== "tshirt_long_sleeve"
  ) {
    return false;
  }
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
  if (
    item.tryOnGarmentTemplate !== "tshirt_short_sleeve" &&
    item.tryOnGarmentTemplate !== "tshirt_long_sleeve"
  ) {
    throw new Error("try-on garment template is invalid");
  }
  // The daemon grant is an opaque read credential. The V2 source field names
  // its query credential `token`; it is created only for this start message
  // and is never retained by the store or diagnostics.
  const url = new URL(readyUrl);
  const credential = url.searchParams.get("grant");
  if (!credential) throw new Error("try-on garment media grant is missing");
  url.search = `?token=${credential}`;
  return visionV2GarmentSourceSchema.parse({
    assetId: media.id,
    reference: url.toString(),
    digest: media.digest,
    contentType: media.contentType,
    byteSize: media.byteSize,
    template: item.tryOnGarmentTemplate,
  });
}

export function validateTryOnResultReference(
  value: unknown,
  context: VisionTryOnResultContext,
): VisionV2ResultReference {
  const parsed = visionV2ResultReferenceSchema.parse(value);
  if (parsed.reference.includes("%")) {
    throw new Error("Vision returned an unsafe try-on result reference");
  }
  const socket = new URL(context.visionSocketUrl);
  if (
    (socket.protocol !== "ws:" && socket.protocol !== "wss:") ||
    socket.username !== "" ||
    socket.password !== ""
  ) {
    throw new Error("Vision socket origin is invalid");
  }
  const expectedProtocol = socket.protocol === "ws:" ? "http:" : "https:";
  const url = new URL(parsed.reference);
  if (
    url.protocol !== expectedProtocol ||
    url.host !== socket.host ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== `/v2/try-on/results/${context.attemptId}` ||
    !/^\?token=[A-Za-z0-9_-]{1,128}$/.test(url.search)
  ) {
    throw new Error("Vision returned an unsafe try-on result reference");
  }
  return parsed;
}

function isReadyLoopbackMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    managedMediaLoopbackUrlSchema.parse(value);
    return true;
  } catch {
    return false;
  }
}
