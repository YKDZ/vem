import { describe, expect, it } from "vitest";

import { resolveManagedMediaReference } from "./managed-media";

describe("Managed Media Resolution", () => {
  it("resolves a managed reference against the provisioned API origin including its port", () => {
    expect(
      resolveManagedMediaReference(
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        "http://118.25.104.160:26849/api",
      ),
    ).toEqual({
      url: "http://118.25.104.160:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      diagnostic: null,
    });
  });

  it("rejects external and traversal-like references without changing the API origin", () => {
    for (const reference of [
      "https://assets.example/product.png",
      "/api/media-assets/../admin/content",
    ]) {
      expect(
        resolveManagedMediaReference(
          reference,
          "http://118.25.104.160:26849/api",
        ),
      ).toEqual({
        url: null,
        diagnostic:
          "managed media reference is outside the allowed content path",
      });
    }
  });
});
