import { describe, expect, it } from "vitest";
// @vitest-environment jsdom
import { createApp, nextTick } from "vue";

import ManagedMediaImage from "./ManagedMediaImage.vue";

describe("ManagedMediaImage", () => {
  it("uses a placeholder and emits a diagnostic when the managed image cannot load", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const diagnostics: Array<{ diagnosticKey: string; message: string }> = [];
    const app = createApp(ManagedMediaImage, {
      reference:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      diagnosticKey: "media:slot-1:coverImageUrl",
      apiBaseUrl: "http://118.25.104.160:26849/api",
      fallback: "/assets/placeholder.png",
      alt: "基础短袖",
      onDiagnostic: (event: { diagnosticKey: string; message: string }) =>
        diagnostics.push(event),
    });
    app.mount(host);

    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(
      "http://118.25.104.160:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
    );

    image.dispatchEvent(new Event("error"));
    await nextTick();

    expect(image.getAttribute("src")).toBe("/assets/placeholder.png");
    expect(diagnostics).toEqual([
      {
        diagnosticKey: "media:slot-1:coverImageUrl",
        message: "managed media failed to load",
      },
    ]);
    app.unmount();
    host.remove();
  });
});
