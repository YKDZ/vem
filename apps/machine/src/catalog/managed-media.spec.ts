import { describe, expect, it } from "vitest";

import { resolveDaemonManagedMedia } from "./managed-media";

const projection = {
  descriptor: {
    id: "550e8400-e29b-41d4-a716-446655440124",
    reference: "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 1,
    purpose: "product_display_image" as const,
    revision: { catalogRevision: "catalog-1" },
  },
  readiness: "ready" as const,
  readyUrl: "http://127.0.0.1:4312/media/sha256:abc?grant=one-shot",
  diagnostic: null,
};

describe("Managed Media Resolution", () => {
  it("uses only a daemon loopback ready URL", () => {
    expect(resolveDaemonManagedMedia(projection, "/placeholder.png").url).toBe(
      projection.readyUrl,
    );
    expect(
      resolveDaemonManagedMedia(
        { ...projection, readyUrl: "https://platform.example/image.png" },
        "/placeholder.png",
      ),
    ).toEqual({
      url: "/placeholder.png",
      diagnostic: "daemon media URL is not loopback",
    });
  });

  it("keeps a stable placeholder while warming or unavailable", () => {
    expect(
      resolveDaemonManagedMedia(
        { ...projection, readiness: "warming", readyUrl: null },
        "/placeholder.png",
      ),
    ).toEqual({
      url: "/placeholder.png",
      diagnostic: "managed media is warming",
    });
  });
});
