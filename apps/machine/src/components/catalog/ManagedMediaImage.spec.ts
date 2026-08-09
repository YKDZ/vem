import { describe, expect, it } from "vitest";
// @vitest-environment jsdom
import { createApp, nextTick } from "vue";

import ManagedMediaImage from "./ManagedMediaImage.vue";

describe("ManagedMediaImage", () => {
  it("uses a placeholder and emits a diagnostic when the managed image cannot load", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const diagnostics: Array<{
      diagnosticKey: string;
      message: string;
      reason?: string;
    }> = [];
    const app = createApp(ManagedMediaImage, {
      reference:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      diagnosticKey: "media:slot-1:coverImageUrl",
      fallback: "/assets/placeholder.png",
      alt: "基础短袖",
      mediaDiagnostic: {
        reason: "digest_mismatch",
        message: "cached bytes do not match the descriptor",
      },
      onDiagnostic: (event: {
        diagnosticKey: string;
        message: string;
        reason?: string;
      }) => diagnostics.push(event),
    });
    app.mount(host);

    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/assets/placeholder.png");

    image.dispatchEvent(new Event("error"));
    await nextTick();

    expect(image.getAttribute("src")).toBe("/assets/placeholder.png");
    expect(diagnostics).toEqual([
      {
        diagnosticKey:
          "media:slot-1:coverImageUrl:managed:/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
        message: "cached bytes do not match the descriptor",
        reason: "digest_mismatch",
      },
    ]);
    app.unmount();
    host.remove();
  });
});
