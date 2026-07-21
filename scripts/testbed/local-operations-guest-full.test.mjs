import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalPlanogramSlot,
  manualDispenseFrames,
  parseLocalOperationsGuestArgs,
  validateLocalOperationsEvidence,
} from "./local-operations-guest-full.mjs";

describe("local operations guest full", () => {
  it("parses the installed guest contract", () => {
    assert.equal(
      parseLocalOperationsGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
      ]).mode,
      "full",
    );
  });
  it("uses canonical slotCode and planogram identity", () => {
    assert.deepEqual(
      canonicalPlanogramSlot(
        {
          planogramVersion: "P-8",
          items: [{ slotCode: "R7C1", slotId: "slot-7", inventoryId: "inv-7" }],
        },
        "R7C1",
      ).planogramVersion,
      "P-8",
    );
    assert.throws(
      () =>
        canonicalPlanogramSlot({ planogramVersion: "P-8", items: [] }, "R7C1"),
      /unavailable/,
    );
  });
  it("isolates serial frames emitted by the manual operation", () => {
    const heartbeat = { parsedOpcode: "AB" };
    const vend = {
      direction: "daemon-to-controller",
      parsedOpcode: "VEND",
    };
    assert.deepEqual(
      manualDispenseFrames(
        { rawFrames: [heartbeat] },
        { rawFrames: [heartbeat, vend] },
      ),
      [vend],
    );
  });
  it("requires business evidence without gating on VM touch-keyboard support", () => {
    const report = {
      schemaVersion: "vem-local-operations-guest-full/v1",
      ok: true,
      boundaries: { daemon: true, hardwareSelfCheck: true, serial: true },
      planogram: { canonical: true, planogramVersion: "P-8", slotCode: "R7C1" },
      manualDispense: { slotCode: "R7C1", outcome: "completed" },
      systemTouchKeyboard: {
        ok: false,
        blocking: false,
        error: "Windows input pane rejected the virtual-keyboard host",
      },
    };
    assert.equal(validateLocalOperationsEvidence(report).canonical, true);
    assert.throws(
      () =>
        validateLocalOperationsEvidence({
          ...report,
          planogram: { ...report.planogram, canonical: false },
        }),
      /boundary/,
    );
  });
});
