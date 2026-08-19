import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAcceptanceReport,
  validateAcceptanceReport,
  validateReportWithValidators,
} from "./acceptance-report.ts";
import { businessAssertion } from "./observation-record.ts";

function passingAssertions() {
  return [
    businessAssertion({
      id: "catalog-rendered",
      source: "machine-ui-dom",
      expected: { route: "#/catalog" },
      observed: { route: "#/catalog" },
    }),
  ];
}

function failingAssertions() {
  return [
    businessAssertion({
      id: "catalog-rendered",
      source: "machine-ui-dom",
      expected: { route: "#/catalog" },
      observed: { route: "#/try-on" },
    }),
  ];
}

describe("acceptance report v2", () => {
  it("builds a report from per-track assertion sets", () => {
    const report = buildAcceptanceReport({
      runId: "RUN-1",
      mode: "fast",
      pass: 1,
      businessSets: [
        {
          name: "startup",
          assertions: passingAssertions(),
        },
      ],
    });
    assert.equal(report.schemaVersion, "vem-runtime-testbed-report/v2");
    assert.equal(report.businessSets[0].status, "passed");
    assert.equal(report.businessSets[0].assertionCount, 1);
    validateAcceptanceReport(report);
  });

  it("flags a failed assertion as the business set failure", () => {
    const report = buildAcceptanceReport({
      runId: "RUN-1",
      mode: "full",
      pass: 1,
      businessSets: [
        {
          name: "visionExperience",
          assertions: failingAssertions(),
        },
      ],
    });
    assert.equal(report.businessSets[0].status, "failed");
    assert.equal(report.businessSets[0].primaryFailure!.id, "catalog-rendered");
  });

  it("rejects a malformed report", () => {
    assert.throws(
      () =>
        validateAcceptanceReport({
          schemaVersion: "vem-runtime-testbed-report/v2",
          runId: "RUN-1",
          mode: "fast",
          pass: 1,
          businessSets: "not-an-array",
        }),
      /businessSets must be an array/,
    );
  });

  it("lets a table-driven validator decide each business set", () => {
    const report = buildAcceptanceReport({
      runId: "RUN-1",
      mode: "fast",
      pass: 1,
      businessSets: [
        { name: "startup", assertions: passingAssertions() },
        { name: "sale", assertions: failingAssertions() },
      ],
    });
    const result = validateReportWithValidators(report, {
      startup: (set) => ({ ok: true, errors: [] }),
      sale: (set) => ({ ok: set.status === "passed", errors: ["sale failed"] }),
    });
    assert.equal(result.businessSets.startup.status, "passed");
    assert.equal(result.businessSets.sale.status, "failed");
    assert.deepEqual(result.businessSets.sale.errors, ["sale failed"]);
  });
});
