import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const nestedCustomerRoute = [
        "#",
        "products",
        "product-key",
        "try-on",
      ].join("/");
      const retiredSelector = ["try", "on", "exit"].join("-");
      const fabricatedPhaseField = ["completed", "Observed"].join("");
      const retiredSessionModule = ["try", "_on", "_session"].join("");
      const retiredProtocolFixture = ["rejects-v", "1", "-protocol"].join("");
      const retiredProgressEvent = dot(
        "vision",
        "try_on",
        "attempt",
        "progress",
      );
      const retiredField = [
        "try",
        "On",
        ["sil", "hou", "ette"].join(""),
        "Url",
      ].join("");
      const retiredPurpose = [
        "try",
        "_on",
        ["sil", "hou", "ette"].join(""),
      ].join("");
      const retiredUploadRoute = [
        "/media-assets/",
        ["try", "-on-", ["sil", "hou", "ette"].join(""), "s"].join(""),
      ].join("");
      const splitProductionReference =
        'const retired = ["try", "_on_", "sil", "hou", "ette"].join("");';
      const fixtures = [
        ["protocol.txt", dot("vem", "vision", "v1")],
        ["fixture.txt", retiredProtocolFixture],
        ["wire.txt", dot("vision", "try_on", "start")],
        ["progress.txt", retiredProgressEvent],
        ["client.txt", ["use", "TryOn", "Preview"].join("")],
        [
          "route.txt",
          `${pathWithBracedPart("", "try-on", "{session}")}.${["m", "jpeg"].join("")}`,
        ],
        ["media.txt", ["sil", "houette"].join("")],
        ["operation.txt", dot("try_on", "stop_preview")],
        ["nested-route.txt", nestedCustomerRoute],
        ["selector.txt", `[data-test="${retiredSelector}"]`],
        ["phase.txt", fabricatedPhaseField],
        ["session.txt", retiredSessionModule],
        ["field.txt", retiredField],
        ["purpose.txt", `purpose: ${retiredPurpose}`],
        ["endpoint.txt", retiredUploadRoute],
        ["production.ts", splitProductionReference],
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
          "fabricated-try-on-phase-evidence",
          "legacy-nested-customer-route",
          "legacy-preview-route",
          "legacy-silhouette",
          "legacy-silhouette-field",
          "legacy-silhouette-purpose",
          "legacy-silhouette-upload-endpoint",
          "legacy-split-construction",
          "legacy-start-stop-operation",
          "legacy-try-on-client",
          "legacy-try-on-selector",
          "legacy-try-on-session-module",
          "legacy-try-on-wire-message",
          "legacy-v1-fixture",
          "obsolete-try-on-progress-event",
          "protocol-v1",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans built artifacts even when they live under dist", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-artifact-"));
    try {
      const artifact = join(root, "apps", "machine", "dist");
      mkdirSync(artifact, { recursive: true });
      writeFileSync(
        join(artifact, "app.js"),
        ["completed", "Observed"].join("") + "\n",
      );
      const violations = scanHardCutoverAbsence({
        root,
        scopes: [],
        artifactScopes: ["apps/machine/dist"],
      });
      assert.deepEqual(violations, [
        "apps/machine/dist/app.js:fabricated-try-on-phase-evidence",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
