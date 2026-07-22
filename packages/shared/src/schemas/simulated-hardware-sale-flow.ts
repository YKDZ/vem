import { z } from "zod";

import {
  runtimeAcceptanceAssertionSchema,
  runtimeAcceptanceDiagnosticSchema,
} from "./runtime-acceptance";

const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const SHARED_PLATFORM_TARGETS = new Set(["vem-vps", "118.25.104.160"]);
const WINDOWS_COM_PATH = /^COM[1-9][0-9]*$/i;

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
  daemonSerialConfiguration: z.strictObject({
    hardwareAdapter: z.string().min(1),
    scannerAdapter: z.string().min(1),
    lowerControllerPort: z.string().min(1).nullable(),
    scannerPort: z.string().min(1).nullable(),
    lowerControllerPortObserved: z.boolean(),
    scannerPortObserved: z.boolean(),
  }),
  guestSerialEvidence: z.strictObject({
    status: z.enum(["captured", "pending_host_serial_conformance", "missing"]),
    serialSessionId: z.string().min(1).nullable(),
    deviceMappingDigest: z.string().min(1).nullable(),
    scannerInputTransport: z.string().min(1).nullable(),
    mappings: z.array(
      z.strictObject({
        role: z.string().min(1),
        guestPort: z.string().min(1).nullable(),
        connectionState: z.string().min(1),
      }),
    ),
    frames: z.array(
      z.strictObject({
        role: z.string().min(1),
        event: z.string().min(1),
        source: z.string().min(1),
        sequence: z.int().positive(),
        digest: z.string().min(1),
        byteLength: z.int().positive(),
        orderId: z.string().min(1).nullable(),
        paymentId: z.string().min(1).nullable(),
        vendingCommandId: z.string().min(1).nullable(),
      }),
    ),
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
    selectedSlotId: z.string().min(1),
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
    postSaleDispenseMovement: z.strictObject({
      movementId: z.string().min(1).nullable(),
      orderId: z.string().min(1).nullable(),
      vendingCommandId: z.string().min(1).nullable(),
      quantity: z.int().positive().nullable(),
      beforeQuantity: z.int().nonnegative().nullable(),
      afterQuantity: z.int().nonnegative().nullable(),
      deltaQuantity: z.int().negative().nullable(),
      status: z.enum(["accepted", "missing", "rejected"]),
    }),
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
  const lowerControllerPort =
    facts.daemonSerialConfiguration.lowerControllerPort;
  const scannerPort = facts.daemonSerialConfiguration.scannerPort;
  if (facts.daemonSerialConfiguration.hardwareAdapter !== "serial") {
    addDiagnostic(
      "serial_lower_controller_adapter_required",
      "Simulated hardware acceptance requires hardwareAdapter=serial; daemon mock adapters are not serial evidence.",
    );
  }
  if (facts.daemonSerialConfiguration.scannerAdapter !== "serial_text") {
    addDiagnostic(
      "serial_scanner_adapter_required",
      "Simulated hardware acceptance requires scannerAdapter=serial_text.",
    );
  }
  if (
    lowerControllerPort === null ||
    scannerPort === null ||
    !WINDOWS_COM_PATH.test(lowerControllerPort) ||
    !WINDOWS_COM_PATH.test(scannerPort) ||
    !facts.daemonSerialConfiguration.lowerControllerPortObserved ||
    !facts.daemonSerialConfiguration.scannerPortObserved
  ) {
    addDiagnostic(
      "windows_com_path_evidence_required",
      "Both daemon adapters must use observed Windows COM paths; TCP and unobserved paths are not acceptance evidence.",
    );
  }
  if (
    lowerControllerPort === null ||
    scannerPort === null ||
    lowerControllerPort.toUpperCase() === scannerPort.toUpperCase()
  ) {
    addDiagnostic(
      "distinct_virtual_com_mapping_required",
      "Lower-controller and scanner evidence must bind two distinct virtual COM mappings.",
    );
  }
  const serialMappings = new Map(
    facts.guestSerialEvidence.mappings.map((mapping) => [
      mapping.role,
      mapping,
    ]),
  );
  const lowerMapping = serialMappings.get("lower-controller");
  const scannerMapping = serialMappings.get("scanner");
  const mappingsMatchDaemonPorts =
    lowerMapping?.guestPort?.toUpperCase() ===
      lowerControllerPort?.toUpperCase() &&
    scannerMapping?.guestPort?.toUpperCase() === scannerPort?.toUpperCase() &&
    lowerMapping?.connectionState === "connected" &&
    scannerMapping?.connectionState === "connected";
  if (
    facts.guestSerialEvidence.status !== "captured" ||
    facts.guestSerialEvidence.serialSessionId === null ||
    facts.guestSerialEvidence.deviceMappingDigest === null ||
    !mappingsMatchDaemonPorts
  ) {
    addDiagnostic(
      "guest_serial_session_evidence_required",
      "Acceptance requires a guest serial session with connected lower-controller and scanner mappings bound to the daemon COM paths.",
    );
  }
  const serialFrames = facts.guestSerialEvidence.frames;
  const hasBoundGuestFrame = (role: string, event: string) =>
    serialFrames.some(
      (frame) =>
        frame.role === role &&
        frame.event === event &&
        frame.source === "guest-serial-session" &&
        frame.orderId === facts.sale.orderId &&
        frame.paymentId === facts.sale.paymentId &&
        frame.vendingCommandId === facts.sale.vendingCommandId,
    );
  if (
    facts.guestSerialEvidence.scannerInputTransport !== "guest_serial_frame" ||
    !hasBoundGuestFrame("scanner", "scanner-injection") ||
    !hasBoundGuestFrame("lower-controller", "dispense-request") ||
    !hasBoundGuestFrame("lower-controller", "dispense-result")
  ) {
    addDiagnostic(
      "guest_serial_frame_evidence_required",
      "Acceptance requires guest-captured scanner and lower-controller frames for this sale; software injection and missing frames are rejected.",
    );
  }
  if (
    !facts.planogram.syncedFromPlatform ||
    !facts.planogram.applied ||
    !facts.planogram.acknowledged
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
    facts.sale.paymentStatus !== "succeeded" ||
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
    facts.platformState.paymentStatus !== "succeeded" ||
    facts.platformState.fulfillmentStatus !== "dispensed" ||
    !facts.platformState.stockMovementAccepted ||
    facts.platformState.postSaleDispenseMovement.status !== "accepted" ||
    facts.platformState.postSaleDispenseMovement.movementId === null ||
    facts.platformState.postSaleDispenseMovement.orderId !==
      facts.sale.orderId ||
    facts.platformState.postSaleDispenseMovement.vendingCommandId !==
      facts.sale.vendingCommandId ||
    facts.platformState.postSaleDispenseMovement.quantity !== 1 ||
    facts.platformState.postSaleDispenseMovement.deltaQuantity !== -1
  ) {
    addDiagnostic(
      "platform_sale_state_not_updated",
      "Platform/testbed state must bind this fulfilled sale to an accepted post-sale dispense movement and its inventory delta.",
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
