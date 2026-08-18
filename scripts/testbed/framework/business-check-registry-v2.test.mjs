import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBusinessCheckRegistryV2,
  collectSupportingEvidence,
} from "./business-check-registry-v2.mjs";
import { buildAcceptanceReport } from "./acceptance-report.mjs";
import { businessAssertion } from "./observation-record.mjs";

function registry() {
  return createBusinessCheckRegistryV2([
    {
      name: "commissioning",
      fullRequired: true,
      runner: { kind: "node", script: "commissioning.mjs" },
      validator: () => ({ ok: true, errors: [] }),
    },
    {
      name: "sale",
      core: true,
      fullRequired: true,
      runner: { kind: "node", script: "sale.mjs" },
      validator: (set) => ({
        ok: set.status === "passed",
        errors: set.status === "failed" ? ["sale assertions failed"] : [],
      }),
    },
    {
      name: "visionExperience",
      fullRequired: true,
      runner: { kind: "powershell", script: "vision.ps1" },
      validator: () => ({ ok: true, errors: [] }),
    },
  ]);
}

describe("business check registry v2", () => {
  it("selects core sets for default fast and all full-required sets for full", () => {
    const selected = registry();
    assert.deepEqual(
      selected.select({ mode: "fast", focus: [] }).map((set) => set.name),
      ["sale"],
    );
    assert.deepEqual(
      selected.select({ mode: "full", focus: [] }).map((set) => set.name),
      ["commissioning", "sale", "visionExperience"],
    );
  });

  it("deduplicates focus names in canonical order", () => {
    const selected = registry().select({
      mode: "fast",
      focus: ["visionExperience", "visionExperience"],
    });
    assert.deepEqual(
      selected.map((set) => set.name),
      ["visionExperience"],
    );
  });

  it("runs table-driven validators over a built report", () => {
    const report = buildAcceptanceReport({
      runId: "RUN-1",
      mode: "fast",
      pass: 1,
      businessSets: [
        {
          name: "sale",
          assertions: [
            businessAssertion({
              id: "order",
              source: "api",
              expected: { status: "succeeded" },
              observed: { status: "failed" },
            }),
          ],
        },
      ],
    });
    const result = registry().validateReport(report);
    assert.equal(result.businessSets.sale.status, "failed");
    assert.deepEqual(result.businessSets.sale.errors, [
      "sale assertions failed",
    ]);
  });

  it("attaches supporting evidence without changing the business status", () => {
    const evidence = collectSupportingEvidence(
      { name: "sale", status: "passed", supportingEvidence: [] },
      [
        { kind: "screenshot", path: "sale.png" },
        { kind: "log", path: "daemon.log" },
      ],
    );
    assert.equal(evidence.status, "passed");
    assert.deepEqual(
      evidence.supportingEvidence.map((entry) => entry.kind),
      ["screenshot", "log"],
    );
  });
});
