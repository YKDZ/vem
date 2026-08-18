import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  businessAssertion,
  summarizeAssertions,
  serializeObservation,
  deserializeObservation,
  observationStream,
} from "./observation-record.mjs";

describe("business assertion records", () => {
  it("marks a matched expectation as passed", () => {
    const record = businessAssertion({
      id: "try-on-result-surface",
      source: "machine-ui-dom",
      expected: { state: "completed" },
      observed: { state: "completed" },
    });
    assert.equal(record.status, "passed");
    assert.equal(record.reason, null);
  });

  it("marks a mismatched expectation as failed with the observed diff", () => {
    const record = businessAssertion({
      id: "try-on-result-surface",
      source: "machine-ui-dom",
      expected: { state: "completed" },
      observed: { state: "acquiring" },
    });
    assert.equal(record.status, "failed");
    assert.match(record.reason, /expected.*completed.*observed.*acquiring/s);
  });

  it("aggregates an assertion record to passed only when every assertion passes", () => {
    const summary = summarizeAssertions([
      businessAssertion({
        id: "a",
        source: "s",
        expected: { v: 1 },
        observed: { v: 1 },
      }),
      businessAssertion({
        id: "b",
        source: "s",
        expected: { v: 2 },
        observed: { v: 2 },
      }),
    ]);
    assert.equal(summary.status, "passed");
    assert.equal(summary.primaryFailure, null);
  });

  it("reports the first failed assertion as the primary failure", () => {
    const summary = summarizeAssertions([
      businessAssertion({
        id: "a",
        source: "s",
        expected: { v: 1 },
        observed: { v: 1 },
      }),
      businessAssertion({
        id: "b",
        source: "s",
        expected: { v: 2 },
        observed: { v: 3 },
      }),
      businessAssertion({
        id: "c",
        source: "s",
        expected: { v: 4 },
        observed: { v: 5 },
      }),
    ]);
    assert.equal(summary.status, "failed");
    assert.equal(summary.primaryFailure.id, "b");
    assert.match(summary.primaryFailure.reason, /expected.*observed/s);
  });
});

describe("observation JSONL stream", () => {
  it("round-trips observations through stable one-line serialization", async () => {
    const stream = observationStream();
    stream.append({
      type: "business_assertion",
      track: "visionExperience",
      record: businessAssertion({
        id: "preview-decoded",
        source: "machine-ui-dom",
        expected: { naturalWidth: 720 },
        observed: { naturalWidth: 720 },
      }),
    });
    const lines = stream.lines();
    assert.equal(lines.length, 1);
    const restored = await deserializeObservation(lines[0]);
    assert.equal(restored.type, "business_assertion");
    assert.equal(restored.record.id, "preview-decoded");
    assert.equal(restored.record.status, "passed");
  });

  it("refuses a malformed line instead of silently dropping evidence", async () => {
    await assert.rejects(
      deserializeObservation("not-json"),
      /invalid observation line/,
    );
  });
});
