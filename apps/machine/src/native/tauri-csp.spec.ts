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
});
