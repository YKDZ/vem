import { describe, expect, it } from "vitest";

import { managedMediaDescriptorSchema } from "./managed-media";

describe("Managed Media Descriptor", () => {
  it("accepts immutable identity, integrity, media and catalog revision facts", () => {
    const descriptor = managedMediaDescriptorSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440124",
      reference:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 42,
      purpose: "product_display_image",
      revision: { catalogRevision: "catalog-7", assetRevision: "asset-3" },
    });

    expect(descriptor.reference).not.toMatch(/^https?:\/\//);
    expect(descriptor.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an absolute deployment URL or missing integrity facts", () => {
    expect(() =>
      managedMediaDescriptorSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440124",
        reference:
          "https://platform.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        contentType: "image/png",
        byteSize: 42,
        purpose: "product_display_image",
        revision: { catalogRevision: "catalog-7" },
      }),
    ).toThrow();
  });
});
