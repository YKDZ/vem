import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("VM host adapter sale audio dispatch", () => {
  it("dispatches capture-sale-audio to the production extension lifecycle", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/testbed/run-vm-host-adapter.mjs",
        "--operation",
        "capture-sale-audio",
        "--capture-phase",
        "start",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--machine-process-id|--run-id/);
    assert.doesNotMatch(result.stderr, /unsupported operation/);
  });

  it("does not route sale capture through calibration or output selection", () => {
    const source = readFileSync(
      "scripts/testbed/sale-audio-capture-host-adapter.mjs",
      "utf8",
    );
    assert.doesNotMatch(source, /audio_output_calibration/);
    assert.doesNotMatch(source, new RegExp("ConfirmAudio" + "Output"));
    assert.doesNotMatch(source, /endpointId|endpointIdentity/);
  });
});
