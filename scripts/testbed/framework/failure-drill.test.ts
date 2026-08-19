import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BusinessAssertionRecord } from "./observation-record.ts";

import { runFailureDrill } from "./failure-drill.ts";
import { deserializeObservation } from "./observation-record.ts";

describe("failure drill", () => {
  it("proves the primary failure is available without SSH or logs", async () => {
    const drill = await runFailureDrill();
    assert.equal(drill.status, "failed");
    assert.equal(drill.primaryFailure!.id, "drill-result-surface");
    assert.match(
      drill.primaryFailure!.reason!,
      /expected.*completed.*observed.*acquiring/s,
    );
    const restored = (await deserializeObservation(
      drill.serializedLine,
    )) as unknown as { record: BusinessAssertionRecord };
    assert.equal(restored.record.status, "failed");
    assert.equal(restored.record.reason, drill.primaryFailure!.reason);
  });
});
