import { describe, expect, it } from "vitest";

import {
  daemonIpcManagedMediaProjectionSchema,
  daemonIpcManagedMediaReconcileRequestSchema,
  daemonIpcManagedMediaSnapshotSchema,
  managedMediaDescriptorSchema,
} from "./managed-media";

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

  it("strictly validates the generated managed-media IPC wire boundary", () => {
    const descriptor = managedMediaDescriptorSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440124",
      reference:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 42,
      purpose: "product_display_image",
      revision: { catalogRevision: "catalog-7" },
    });
    const request = daemonIpcManagedMediaReconcileRequestSchema.parse({
      generation: "sha256:" + "b".repeat(64),
      interests: [descriptor],
    });
    expect(request.interests[0]).toEqual(descriptor);

    expect(() =>
      daemonIpcManagedMediaReconcileRequestSchema.parse({
        generation: "sha256:" + "b".repeat(64),
        interests: [descriptor],
        legacyDownloadUrl: "https://platform.invalid/media",
      }),
    ).toThrow();
    expect(() =>
      daemonIpcManagedMediaProjectionSchema.parse({
        descriptor,
        readiness: "ready",
        readyUrl: "https://platform.invalid/media/sha256:" + "a".repeat(64),
        diagnostic: null,
      }),
    ).toThrow();
    expect(() =>
      daemonIpcManagedMediaProjectionSchema.parse({
        descriptor,
        readiness: "broken",
        readyUrl: null,
        diagnostic: null,
      }),
    ).toThrow();
  });

  it("round-trips a complete warming snapshot and rejects invalid digest facts", () => {
    const value = {
      generation: "sha256:" + "b".repeat(64),
      assets: [
        {
          descriptor: {
            id: "550e8400-e29b-41d4-a716-446655440124",
            reference:
              "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
            digest: `sha256:${"a".repeat(64)}`,
            contentType: "image/png",
            byteSize: 42,
            purpose: "product_display_image",
            revision: { catalogRevision: "catalog-7" },
          },
          readiness: "warming",
          readyUrl: null,
          diagnostic: null,
        },
      ],
    };
    expect(daemonIpcManagedMediaSnapshotSchema.parse(value)).toEqual(value);
    expect(() =>
      daemonIpcManagedMediaSnapshotSchema.parse({
        ...value,
        assets: [
          {
            ...value.assets[0],
            descriptor: { ...value.assets[0].descriptor, digest: "sha256:bad" },
          },
        ],
      }),
    ).toThrow();
  });
});
