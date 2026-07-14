import { z } from "zod";

import {
  runtimeAcceptanceAssertionSchema,
  runtimeAcceptanceDiagnosticSchema,
} from "./runtime-acceptance";

const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const SHARED_PLATFORM_TARGETS = new Set(["vem-vps", "118.25.104.160"]);

const simulatedHardwareSaleFlowResultSchema = z.strictObject({
  simulatedHardwareReady: runtimeAcceptanceAssertionSchema,
  sellReady: runtimeAcceptanceAssertionSchema,
});

export const simulatedHardwareSaleFlowFactsSchema = z.strictObject({
  mode: z.literal("simulated_hardware_fresh_bring_up_sale_flow"),
  target: z.strictObject({
    testbedName: z.string().min(1),
    machineCode: z.string().min(1),
    platformTarget: z.string().min(1),
  }),
  runtimeState: z.strictObject({
    hardwareMode: z.enum(["simulated", "production"]),
    hardwareModel: z.string().min(1),
    bringUpState: z.string().min(1),
    uiDiagnosticsExplicit: z.boolean(),
  }),
  provisioning: z.strictObject({
    provisioned: z.boolean(),
    usedMachineClaimCodePath: z.boolean(),
    usedDaemonIpcClaimPath: z.boolean(),
    profileApplied: z.boolean(),
    machineCode: z.string().min(1).nullable(),
    claim: z.strictObject({
      runId: z.string().min(1),
      status: z.enum(["provisioned", "failed", "not_attempted"]),
      httpStatus: z.int().positive().nullable(),
      failureCode: z.string().min(1).nullable(),
      endpoint: z.string().min(1),
    }),
    profile: z.strictObject({
      status: z.enum(["applied", "failed", "missing"]),
      machineSecretConfigured: z.boolean(),
      mqttSigningSecretConfigured: z.boolean(),
      mqttPasswordConfigured: z.boolean(),
    }),
  }),
  platformSetup: z.strictObject({
    ephemeral: z.boolean(),
    preparedRunId: z.string().min(1),
    target: z.string().min(1),
    apiBaseUrl: z.string().min(1),
    mqttUrl: z.string().min(1),
    evidenceStatus: z.enum(["prepared", "missing", "failed"]),
    claimPath: z.literal("/api/machines/claim"),
    mockPaymentReady: z.boolean(),
  }),
  topology: z.strictObject({
    expectedIdentity: z.string().min(1),
    expectedVersion: z.string().min(1),
    verified: z.boolean(),
  }),
  planogram: z.strictObject({
    syncedFromPlatform: z.boolean(),
    applied: z.boolean(),
    acknowledged: z.boolean(),
    acknowledgmentId: z.string().min(1).nullable(),
    syncStatus: z.enum(["acknowledged", "failed", "missing"]),
    planogramVersion: z.string().min(1),
    slotCount: z.int().positive(),
  }),
  stock: z.strictObject({
    establishedBy: z.enum(["stock_attestation", "stock_movement"]),
    evidenceId: z.string().min(1),
    uploadStatus: z.enum(["accepted", "rejected", "missing"]),
    platformMovementId: z.string().min(1).nullable(),
    planogramVersion: z.string().min(1),
    saleableSlots: z.int().nonnegative(),
    totalOnHand: z.int().nonnegative(),
  }),
  sale: z.strictObject({
    saleViewReady: z.boolean(),
    selectedSlotCode: z.string().min(1),
    orderId: z.string().min(1).nullable(),
    orderNo: z.string().min(1).nullable(),
    orderStatus: z.string().min(1),
    paymentMethod: z.string().min(1),
    paymentProviderCode: z.string().min(1).nullable(),
    paymentId: z.string().min(1).nullable(),
    paymentNo: z.string().min(1).nullable(),
    paymentStatus: z.string().min(1),
    paymentSucceeded: z.boolean(),
    vendingCommandId: z.string().min(1).nullable(),
    dispenseSimulated: z.boolean(),
    dispenseResult: z.enum(["dispensed", "failed", "unknown"]),
    dispenseSucceeded: z.boolean(),
    customerResult: z.enum(["success", "failed", "unknown"]),
  }),
  platformState: z.strictObject({
    orderStatus: z.string().min(1),
    paymentStatus: z.string().min(1),
    fulfillmentStatus: z.string().min(1),
    stockMovementAccepted: z.boolean(),
  }),
});

export const simulatedHardwareSaleFlowReportSchema =
  simulatedHardwareSaleFlowFactsSchema
    .extend({
      schemaVersion: z.literal("simulated-hardware-sale-flow/v1"),
      result: simulatedHardwareSaleFlowResultSchema,
      diagnostics: z.array(runtimeAcceptanceDiagnosticSchema),
    })
    .superRefine((report, ctx) => {
      if (report.result.sellReady.status !== "not_asserted") {
        ctx.addIssue({
          code: "custom",
          path: ["result", "sellReady"],
          message:
            "simulated-hardware-sale-flow/v1 must not assert production sell-ready.",
        });
      }
    });

export type SimulatedHardwareSaleFlowFacts = z.infer<
  typeof simulatedHardwareSaleFlowFactsSchema
>;
export type SimulatedHardwareSaleFlowReport = z.infer<
  typeof simulatedHardwareSaleFlowReportSchema
>;

function passedAssertion(): z.infer<typeof runtimeAcceptanceAssertionSchema> {
  return { status: "passed", asserted: true };
}

function failedAssertion(): z.infer<typeof runtimeAcceptanceAssertionSchema> {
  return { status: "failed", asserted: false };
}

function notAssertedAssertion(): z.infer<
  typeof runtimeAcceptanceAssertionSchema
> {
  return { status: "not_asserted", asserted: false };
}

export function classifySimulatedHardwareSaleFlowReport(
  facts: SimulatedHardwareSaleFlowFacts,
): SimulatedHardwareSaleFlowReport {
  const diagnostics: z.infer<typeof runtimeAcceptanceDiagnosticSchema>[] = [];
  const addDiagnostic = (code: string, message: string) => {
    diagnostics.push({ code, message });
  };

  if (!facts.target.machineCode.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
    addDiagnostic(
      "testbed_machine_identity_required",
      "Simulated hardware sale-flow evidence must use a VEM-TESTBED-* machine identity.",
    );
  }
  if (facts.provisioning.machineCode !== facts.target.machineCode) {
    addDiagnostic(
      "daemon_config_machine_identity_mismatch",
      "Daemon-observed machine identity must match the requested testbed target.",
    );
  }
  if (facts.runtimeState.hardwareMode !== "simulated") {
    addDiagnostic(
      "simulated_hardware_mode_required",
      "Simulated hardware sale-flow evidence must be captured in Simulated Hardware Mode.",
    );
  }
  if (facts.runtimeState.bringUpState !== "simulated_hardware_ready") {
    addDiagnostic(
      "simulated_hardware_ready_state_missing",
      "Runtime state must report simulated_hardware_ready before simulated sale flow evidence can pass.",
    );
  }
  if (!facts.runtimeState.uiDiagnosticsExplicit) {
    addDiagnostic(
      "ui_simulated_hardware_diagnostics_missing",
      "Machine UI diagnostics must explicitly identify Simulated Hardware Mode.",
    );
  }
  if (!facts.platformSetup.ephemeral) {
    addDiagnostic(
      "ephemeral_platform_stack_required",
      "Simulated hardware sale-flow evidence must use an ephemeral platform stack.",
    );
  }
  if (
    facts.platformSetup.evidenceStatus !== "prepared" ||
    facts.platformSetup.preparedRunId !== facts.provisioning.claim.runId ||
    facts.platformSetup.target !== facts.target.platformTarget
  ) {
    addDiagnostic(
      "ephemeral_platform_evidence_required",
      "Simulated hardware sale-flow evidence must prove ephemeral platform setup for the same run and target.",
    );
  }
  const platformTargetValues = [
    facts.target.platformTarget,
    facts.platformSetup.target,
    facts.platformSetup.apiBaseUrl,
    facts.platformSetup.mqttUrl,
  ].map((value) => value.toLowerCase());
  if (
    platformTargetValues.some((value) =>
      Array.from(SHARED_PLATFORM_TARGETS).some((sharedTarget) =>
        value.includes(sharedTarget),
      ),
    )
  ) {
    addDiagnostic(
      "shared_platform_target_rejected",
      "Simulated hardware sale-flow evidence must not target the shared vem-vps platform.",
    );
  }
  if (!facts.platformSetup.mockPaymentReady) {
    addDiagnostic(
      "mock_payment_readiness_missing",
      "Ephemeral platform setup must prepare mock payment readiness for the sale flow.",
    );
  }
  if (
    !facts.provisioning.provisioned ||
    !facts.provisioning.usedMachineClaimCodePath ||
    !facts.provisioning.usedDaemonIpcClaimPath ||
    !facts.provisioning.profileApplied ||
    facts.provisioning.profile.status !== "applied" ||
    !facts.provisioning.profile.machineSecretConfigured ||
    !facts.provisioning.profile.mqttSigningSecretConfigured
  ) {
    addDiagnostic(
      "machine_claim_profile_path_incomplete",
      "Testbed provisioning must use the Machine Claim Code path through daemon IPC and apply the platform profile.",
    );
  }
  if (
    facts.provisioning.claim.runId !== facts.platformSetup.preparedRunId ||
    facts.provisioning.claim.status !== "provisioned" ||
    !facts.provisioning.claim.endpoint.endsWith("/v1/provisioning/claim") ||
    facts.provisioning.claim.httpStatus !== 200
  ) {
    addDiagnostic(
      "fresh_machine_claim_evidence_required",
      "Simulated hardware sale-flow evidence must include a successful daemon IPC claim from the same run.",
    );
  }
  if (!facts.topology.verified) {
    addDiagnostic(
      "hardware_topology_not_verified",
      "Daemon must verify the expected hardware slot topology before simulated sale flow.",
    );
  }
  if (
    !facts.planogram.syncedFromPlatform ||
    !facts.planogram.applied ||
    !facts.planogram.acknowledged ||
    facts.planogram.syncStatus !== "acknowledged" ||
    facts.planogram.acknowledgmentId === null
  ) {
    addDiagnostic(
      "platform_planogram_not_acknowledged",
      "Daemon must sync, apply, and acknowledge the platform planogram before simulated sale flow.",
    );
  }
  if (facts.stock.planogramVersion !== facts.planogram.planogramVersion) {
    addDiagnostic(
      "stock_planogram_mismatch",
      "Initial stock evidence must be recorded against the active acknowledged planogram.",
    );
  }
  if (facts.stock.saleableSlots < 1 || facts.stock.totalOnHand < 1) {
    addDiagnostic(
      "initial_stock_missing",
      "Initial stock must be established through stock attestation or stock movement paths.",
    );
  }
  if (
    facts.stock.uploadStatus !== "accepted" ||
    facts.stock.platformMovementId === null
  ) {
    addDiagnostic(
      "stock_upload_not_accepted",
      "Initial stock evidence must include an accepted platform stock movement or attestation upload.",
    );
  }
  if (
    !facts.sale.saleViewReady ||
    facts.sale.orderId === null ||
    facts.sale.orderNo === null ||
    facts.sale.orderStatus !== "fulfilled" ||
    facts.sale.paymentMethod !== "payment_code" ||
    facts.sale.paymentProviderCode !== "mock" ||
    facts.sale.paymentId === null ||
    facts.sale.paymentNo === null ||
    facts.sale.paymentStatus !== "paid" ||
    !facts.sale.paymentSucceeded ||
    facts.sale.vendingCommandId === null ||
    !facts.sale.dispenseSimulated ||
    facts.sale.dispenseResult !== "dispensed" ||
    !facts.sale.dispenseSucceeded ||
    facts.sale.customerResult !== "success"
  ) {
    addDiagnostic(
      "simulated_customer_sale_not_successful",
      "Simulated payment and simulated dispense must reach a successful customer-facing result.",
    );
  }
  if (
    facts.platformState.paymentStatus !== "paid" ||
    facts.platformState.fulfillmentStatus !== "dispensed" ||
    !facts.platformState.stockMovementAccepted
  ) {
    addDiagnostic(
      "platform_sale_state_not_updated",
      "Platform/testbed state must reflect paid, dispensed, and accepted stock movement results.",
    );
  }

  return {
    schemaVersion: "simulated-hardware-sale-flow/v1",
    ...facts,
    result: {
      simulatedHardwareReady:
        diagnostics.length === 0 ? passedAssertion() : failedAssertion(),
      sellReady: notAssertedAssertion(),
    },
    diagnostics,
  };
}
