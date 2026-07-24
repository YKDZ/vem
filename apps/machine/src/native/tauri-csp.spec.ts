import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("installed machine managed-media policy", () => {
  it("allows media from the provisioned platform origin instead of one deployment host", () => {
    const configuration = JSON.parse(
      readFileSync(
        new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { app?: { security?: { csp?: string } } };
    const csp = configuration.app?.security?.csp ?? "";

    expect(csp).toContain("img-src 'self' data: blob: http: https:");
    expect(csp).toContain("connect-src 'self' http: https: ws: wss: mqtt:");
    expect(csp).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it("keeps installed Windows WebView observable without dropping default disabled features", () => {
    const configuration = JSON.parse(
      readFileSync(
        new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { app?: { windows?: Array<{ additionalBrowserArgs?: string }> } };
    const additionalBrowserArgs =
      configuration.app?.windows?.[0]?.additionalBrowserArgs ?? "";

    expect(additionalBrowserArgs).toContain("--remote-debugging-port=9222");
    expect(additionalBrowserArgs).toContain(
      "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    );
  });
});
