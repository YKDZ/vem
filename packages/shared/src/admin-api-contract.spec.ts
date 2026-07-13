import { describe, expect, it } from "vitest";

import { parseAdminApiResponse } from "./admin-api-contract";
import {
  adminProductDisplayImageUploadContract,
  adminTryOnSilhouetteUploadContract,
} from "./schemas/products";

const summary = {
  id: "550e8400-e29b-41d4-a716-446655440125",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
  contentType: "image/png",
};

describe("Admin API response contracts", () => {
  it.each([
    adminProductDisplayImageUploadContract,
    adminTryOnSilhouetteUploadContract,
  ])("strictly parses $method $path responses", (contract) => {
    expect(parseAdminApiResponse(contract, summary)).toEqual(summary);
    expect(() =>
      parseAdminApiResponse(contract, {
        ...summary,
        storageKey: "private/storage-key.png",
        sha256: "private-digest",
      }),
    ).toThrow();
  });
});
