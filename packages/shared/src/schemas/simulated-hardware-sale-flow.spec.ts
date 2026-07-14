import { describe, expect, it } from "vitest";

import {
  classifySimulatedHardwareSaleFlowReport,
  simulatedHardwareSaleFlowReportSchema,
  type SimulatedHardwareSaleFlowFacts,
} from "./simulated-hardware-sale-flow";

function completeFacts(): SimulatedHardwareSaleFlowFacts {
  return {
    mode: "simulated_hardware_fresh_bring_up_sale_flow",
    target: {
      testbedName: "win10-vem-e2e",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "ephemeral-local",
    },
    runtimeState: {
      hardwareMode: "simulated",
      hardwareModel: "win10-runtime-testbed",
      bringUpState: "simulated_hardware_ready",
      uiDiagnosticsExplicit: true,
    },
    provisioning: {
      provisioned: true,
      usedMachineClaimCodePath: true,
      usedDaemonIpcClaimPath: true,
      profileApplied: true,
      machineCode: "VEM-TESTBED-WINVM-01",
      claim: {
        runId: "RUN-180",
        status: "provisioned",
        httpStatus: 200,
        failureCode: null,
        endpoint: "/v1/provisioning/claim",
      },
      profile: {
        status: "applied",
        machineSecretConfigured: true,
        mqttSigningSecretConfigured: true,
        mqttPasswordConfigured: false,
      },
    },
    platformSetup: {
      ephemeral: true,
      preparedRunId: "RUN-180",
      target: "ephemeral-local",
      apiBaseUrl: "http://127.0.0.1:26849/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      evidenceStatus: "prepared",
      claimPath: "/api/machines/claim",
      mockPaymentReady: true,
    },
    topology: {
      expectedIdentity: "vem-prod-24",
      expectedVersion: "2026-06-adr0026",
      verified: true,
    },
    planogram: {
      syncedFromPlatform: true,
      applied: true,
      acknowledged: true,
      acknowledgmentId: "PLANOGRAM-ACK-RUN-180",
      syncStatus: "acknowledged",
      planogramVersion: "TESTBED-RUN-180",
      slotCount: 2,
    },
    stock: {
      establishedBy: "stock_attestation",
      evidenceId: "STOCK-ATTEST-RUN-180",
      uploadStatus: "accepted",
      platformMovementId: "STOCK-MOVE-RUN-180",
      planogramVersion: "TESTBED-RUN-180",
      saleableSlots: 2,
      totalOnHand: 6,
    },
    sale: {
      saleViewReady: true,
      selectedSlotCode: "A1",
      orderId: "ORDER-ID-180",
      orderNo: "MO-180",
      orderStatus: "fulfilled",
      paymentMethod: "payment_code",
      paymentProviderCode: "mock",
      paymentId: "PAYMENT-ID-180",
      paymentNo: "PAY-180",
      paymentStatus: "paid",
      paymentSucceeded: true,
      vendingCommandId: "VEND-CMD-180",
      dispenseSimulated: true,
      dispenseResult: "dispensed",
      dispenseSucceeded: true,
      customerResult: "success",
    },
    platformState: {
      orderStatus: "fulfilled",
      paymentStatus: "paid",
      fulfillmentStatus: "dispensed",
      stockMovementAccepted: true,
    },
  };
}

describe("Simulated Hardware Sale Flow Report contract", () => {
  it("asserts simulated-hardware-ready separately from production sell-ready", () => {
    const report = classifySimulatedHardwareSaleFlowReport(completeFacts());

    expect(simulatedHardwareSaleFlowReportSchema.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe("simulated-hardware-sale-flow/v1");
    expect(report.result.simulatedHardwareReady).toEqual({
      status: "passed",
      asserted: true,
    });
    expect(report.result.sellReady).toEqual({
      status: "not_asserted",
      asserted: false,
    });
    expect(report.diagnostics).toEqual([]);
  });

  it("fails simulated-hardware-ready when evidence claims production hardware mode", () => {
    const facts = completeFacts();
    facts.runtimeState.hardwareMode = "production";
    facts.runtimeState.bringUpState = "sell_ready";

    const report = classifySimulatedHardwareSaleFlowReport(facts);

    expect(report.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.result.sellReady).toEqual({
      status: "not_asserted",
      asserted: false,
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "simulated_hardware_mode_required",
    );
  });

  it("rejects stale or failed claim evidence from a different run", () => {
    const staleFacts = completeFacts();
    staleFacts.provisioning.claim.runId = "OLDER-RUN";

    const staleReport = classifySimulatedHardwareSaleFlowReport(staleFacts);

    expect(staleReport.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(
      staleReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("fresh_machine_claim_evidence_required");

    const failedFacts = completeFacts();
    failedFacts.provisioning.claim.status = "failed";
    failedFacts.provisioning.claim.httpStatus = 409;
    failedFacts.provisioning.claim.failureCode = "already_claimed";

    const failedReport = classifySimulatedHardwareSaleFlowReport(failedFacts);

    expect(failedReport.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(
      failedReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("fresh_machine_claim_evidence_required");
  });

  it("requires same-run ephemeral platform setup evidence and rejects shared targets", () => {
    const missingEvidenceFacts = completeFacts();
    missingEvidenceFacts.platformSetup.evidenceStatus = "missing";

    const missingEvidenceReport =
      classifySimulatedHardwareSaleFlowReport(missingEvidenceFacts);

    expect(missingEvidenceReport.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(
      missingEvidenceReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("ephemeral_platform_evidence_required");

    const sharedTargetFacts = completeFacts();
    sharedTargetFacts.target.platformTarget = "vem-vps";
    sharedTargetFacts.platformSetup.target = "vem-vps";
    sharedTargetFacts.platformSetup.apiBaseUrl =
      "http://118.25.104.160:26849/api";

    const sharedTargetReport =
      classifySimulatedHardwareSaleFlowReport(sharedTargetFacts);

    expect(sharedTargetReport.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(
      sharedTargetReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("shared_platform_target_rejected");
  });

  it("requires concrete sale-flow evidence ids and accepted stock upload status", () => {
    const report = classifySimulatedHardwareSaleFlowReport(completeFacts());

    expect(report.planogram.acknowledgmentId).toBe("PLANOGRAM-ACK-RUN-180");
    expect(report.stock.platformMovementId).toBe("STOCK-MOVE-RUN-180");
    expect(report.sale.orderId).toBe("ORDER-ID-180");
    expect(report.sale.paymentId).toBe("PAYMENT-ID-180");
    expect(report.sale.paymentNo).toBe("PAY-180");
    expect(report.sale.vendingCommandId).toBe("VEND-CMD-180");
    expect(simulatedHardwareSaleFlowReportSchema.parse(report)).toEqual(report);

    const missingStockUploadFacts = completeFacts();
    missingStockUploadFacts.stock.uploadStatus = "missing";
    missingStockUploadFacts.stock.platformMovementId = null;
    missingStockUploadFacts.platformState.stockMovementAccepted = true;

    const missingStockUploadReport = classifySimulatedHardwareSaleFlowReport(
      missingStockUploadFacts,
    );

    expect(missingStockUploadReport.result.simulatedHardwareReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(
      missingStockUploadReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("stock_upload_not_accepted");
  });
});
