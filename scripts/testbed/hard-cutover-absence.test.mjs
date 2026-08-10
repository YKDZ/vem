import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertHardCutoverAbsence,
  scanHardCutoverAbsence,
} from "./hard-cutover-absence.mjs";

describe("Vision V2 hard-cutover absence guard", () => {
  it("covers Machine, shared contracts, testbed scripts, package metadata, specs, and generated bundles", () => {
    assert.deepEqual(assertHardCutoverAbsence(), []);
  });

  it("detects every retired try-on category through dynamic negative fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-"));
    try {
      const dot = (...parts) => parts.join(".");
      const pathWithBracedPart = (...parts) => parts.join("/");
      const streamExtension = ["m", "jpeg"].join("");
      const fixtures = [
        ["protocol.txt", dot("vem", "vision", "v1")],
        ["wire.txt", dot("vision", "try_on", "start")],
        ["client.txt", ["use", "TryOn", "Preview"].join("")],
        [
          "route.txt",
          `${pathWithBracedPart("", "try-on", "{session}")}.${streamExtension}`,
        ],
        ["media.txt", ["sil", "houette"].join("")],
        ["transport.txt", ["M", "JPEG"].join("")],
        ["operation.txt", dot("try_on", "stop_preview")],
      ];
      for (const [name, body] of fixtures) {
        writeFileSync(join(root, name), `${body}\n`);
      }
      const violations = scanHardCutoverAbsence({
        root,
        scopes: fixtures.map(([name]) => name),
      });
      assert.deepEqual(
        [...new Set(violations.map((entry) => entry.split(":").at(-1)))].sort(),
        [
          "legacy-preview-route",
          "legacy-silhouette",
          "legacy-start-stop-operation",
          "legacy-try-on-client",
          "legacy-try-on-wire-message",
          "protocol-v1",
          "transport-specific-preview",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
