import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseMachineClaimWorkflowGuestArgs,
  parseServiceApiEnvelope,
  validateMachineClaimWorkflowReport,
} from "./machine-claim-workflow-guest-full.ts";

describe("machine claim workflow guest acceptance", () => {
  it("parses the focused full-mode guest invocation", () => {
    assert.deepEqual(
      parseMachineClaimWorkflowGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\VEM\\runtime\\guest-input.json",
        "--handoff",
        "C:\\VEM\\runtime\\handoff.json",
        "--out",
        "C:\\VEM\\runtime\\machine-claim.json",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\VEM\\runtime\\guest-input.json",
        handoffPath: "C:\\VEM\\runtime\\handoff.json",
        outPath: "C:\\VEM\\runtime\\machine-claim.json",
      },
    );
    assert.throws(
      () =>
        parseMachineClaimWorkflowGuestArgs([
          "--mode",
          "fast",
          "--guest-input",
          "guest.json",
          "--handoff",
          "handoff.json",
          "--out",
          "out.json",
        ]),
      /--mode must be full/,
    );
  });

  it("requires a successful Service API envelope", () => {
    assert.deepEqual(parseServiceApiEnvelope({ code: 0, data: { ok: true } }), {
      ok: true,
    });
    assert.throws(
      () => parseServiceApiEnvelope({ code: 1, message: "failed" }),
      /success envelope/,
    );
  });

  it("requires machine, reclaim, submission, and screenshots evidence", () => {
    assert.deepEqual(
      validateMachineClaimWorkflowReport({
        schemaVersion: "vem-machine-claim-workflow-guest-full/v1",
        ok: true,
        machine: { id: "machine-1", code: "VEM-TESTBED-LOCAL" },
        reclaim: {
          claimCodeId: "claim-1",
          purpose: "reclaim",
          revokedPendingClaimCodeIds: [],
        },
        submission: { accepted: true },
        screenshots: {
          beforeSubmit: { sha256: "a".repeat(64) },
          afterSubmit: { sha256: "b".repeat(64) },
        },
      }),
      { machineCode: "VEM-TESTBED-LOCAL", claimCodeId: "claim-1" },
    );
    assert.throws(
      () =>
        validateMachineClaimWorkflowReport({
          schemaVersion: "vem-machine-claim-workflow-guest-full/v1",
          ok: true,
          machine: { id: "machine-1", code: "VEM-TESTBED-LOCAL" },
          reclaim: { claimCodeId: "claim-1", purpose: "first_claim" },
          submission: { accepted: true },
          screenshots: {
            beforeSubmit: { sha256: "a".repeat(64) },
            afterSubmit: { sha256: "b".repeat(64) },
          },
        }),
      /evidence is incomplete/,
    );
  });
});
