import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createSaleAudioCaptureRequest,
  runSaleAudioCaptureHostAdapterCli,
  SALE_AUDIO_REPORT_SCHEMA_VERSION,
  validateSaleAudioCaptureReport,
} from "./sale-audio-capture-host-adapter.mjs";

const runtime = {
  processId: 42,
  executablePath: "C:\\VEM\\bringup\\machine.exe",
  principal: "FIELD\\InteractivePrincipal",
  sessionId: 4,
  cdpTargetId: "target-42",
  cdpSessionId: "cdp-session://42",
};

function report(request) {
  return {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: { identity: "vm-host-adapter://production", version: "1.0.0" },
    request,
    captureSession: {
      captureSessionId: "sale-audio-session://42",
      startOperationReference: request.operationReference,
      startedAt: "2026-07-18T08:00:00.000Z",
    },
    capture: null,
    evidence: [],
  };
}

describe("capture-sale-audio host adapter extension", () => {
  it("starts before business IDs exist while binding the installed process and transaction", () => {
    const request = createSaleAudioCaptureRequest({
      phase: "start",
      runId: "RUN-17",
      lifecycleReference: "vm-lifecycle://run-17.runtime",
      targetIdentity: "vm-target://runtime",
      transactionId: "transaction://run-17",
      runtime,
      operationNonce: "op-1111111111111111",
    });
    const validated = validateSaleAudioCaptureReport(report(request), request);
    assert.equal(validated.request.runtime.principal, runtime.principal);
    assert.equal(validated.request.sale, null);
    assert.equal(validated.request.operation, "capture-sale-audio");
    assert.throws(
      () =>
        validateSaleAudioCaptureReport(
          report({ ...request, endpointId: "forbidden-endpoint" }),
          { ...request, endpointId: "forbidden-endpoint" },
        ),
      /fields are invalid/,
    );
  });

  it("requires the stop request to carry order, command number, command ID, and transaction", () => {
    assert.throws(
      () =>
        createSaleAudioCaptureRequest({
          phase: "stop",
          runId: "RUN-17",
          lifecycleReference: "vm-lifecycle://run-17.runtime",
          targetIdentity: "vm-target://runtime",
          transactionId: "transaction://run-17",
          runtime,
          captureSessionId: "sale-audio-session://42",
          startOperationReference: "vm-operation://op-1111111111111111",
          captureStartedAt: "2026-07-18T08:00:00.000Z",
          sale: {
            saleCorrelationId: "sale-correlation://run-17",
            orderId: "order-17",
            orderNo: "ORDER-17",
            commandId: "command-17",
          },
        }),
      /commandNo/,
    );
  });

  it("is callable through the repo-owned CLI without calibration or endpoint arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sale-audio-host-"));
    let observedRequest;
    try {
      const result = await runSaleAudioCaptureHostAdapterCli(
        [
          "--operation",
          "capture-sale-audio",
          "--capture-phase",
          "start",
          "--run-id",
          "RUN-17",
          "--lifecycle-reference",
          "vm-lifecycle://run-17.runtime",
          "--target-identity",
          "vm-target://runtime",
          "--transaction-id",
          "transaction://run-17",
          "--machine-process-id",
          "42",
          "--machine-executable-path",
          runtime.executablePath,
          "--interactive-principal",
          runtime.principal,
          "--interactive-session-id",
          "4",
          "--cdp-target-id",
          runtime.cdpTargetId,
          "--cdp-session-id",
          runtime.cdpSessionId,
          "--evidence-dir",
          join(root, "evidence"),
          "--out",
          join(root, "report.json"),
        ],
        {
          async invokeAdapter(request) {
            observedRequest = request;
            return report(request);
          },
        },
      );
      assert.equal(result.result, "succeeded");
      assert.equal(observedRequest.operation, "capture-sale-audio");
      assert.equal(
        JSON.stringify(observedRequest).includes("audio_output_calibration"),
        false,
      );
      assert.equal(Object.hasOwn(observedRequest, "endpointId"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
