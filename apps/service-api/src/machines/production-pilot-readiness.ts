import type { MachineHeartbeatStatusPayload } from "@vem/shared";

type ReadinessStatus = "ready" | "blocked" | "degraded";
type CheckStatus = ReadinessStatus | "missing";

export type ProductionPilotReadinessCheck = {
  code: string;
  label: string;
  status: CheckStatus;
  message: string;
  operatorAction: string;
};

type MachineEvidence = {
  status: "online" | "offline" | "maintenance" | "disabled";
  lastSeenAt: Date | null;
};

type LatestHeartbeatEvidence = {
  reportedAt: Date;
  statusPayload: MachineHeartbeatStatusPayload;
} | null;

type PaymentOptionEvidence = {
  providerCode: string;
  method: string;
  mode?: string | null;
};

type PlatformPlanogramEvidence = {
  activeAcknowledgedPlanogramVersion: string | null;
};

export type ProductionPilotReadinessInput = {
  machine: MachineEvidence;
  latestHeartbeat: LatestHeartbeatEvidence;
  paymentOptions: PaymentOptionEvidence[];
  machineHeartbeatTimeoutSeconds: number;
  platformPlanogram?: PlatformPlanogramEvidence;
};

export type ProductionPilotReadiness = {
  status: ReadinessStatus;
  checkedAt: string;
  blockers: ProductionPilotReadinessCheck[];
  degraded: ProductionPilotReadinessCheck[];
  checks: ProductionPilotReadinessCheck[];
};

function evidenceObject(
  payload: MachineHeartbeatStatusPayload | null | undefined,
  field: string,
): Record<string, unknown> | null {
  const value = payload ? Reflect.get(payload, field) : null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = entryValue;
  }
  return result;
}

function evidenceStatus(
  payload: MachineHeartbeatStatusPayload | null | undefined,
  field: string,
): string | null {
  const value = evidenceObject(payload, field)?.["status"];
  return typeof value === "string" ? value : null;
}

function nestedEvidenceStatus(
  payload: MachineHeartbeatStatusPayload | null | undefined,
  field: string,
  nestedField: string,
  evidenceField: string,
): string | null {
  const nested = evidenceObject(payload, field)?.[nestedField];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return null;
  }
  const evidence = Reflect.get(nested, evidenceField);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence)
  ) {
    return null;
  }
  const status = Reflect.get(evidence, "status");
  return typeof status === "string" ? status : null;
}

function evidenceString(
  payload: MachineHeartbeatStatusPayload | null | undefined,
  field: string,
  key: string,
): string | null {
  const value = evidenceObject(payload, field)?.[key];
  return typeof value === "string" ? value : null;
}

function evidenceBoolean(
  payload: MachineHeartbeatStatusPayload | null | undefined,
  field: string,
  key: string,
): boolean | null {
  const value = evidenceObject(payload, field)?.[key];
  return typeof value === "boolean" ? value : null;
}

function check(
  input: ProductionPilotReadinessCheck,
): ProductionPilotReadinessCheck {
  return input;
}

export function evaluateProductionPilotReadiness(
  input: ProductionPilotReadinessInput,
  now = new Date(),
): ProductionPilotReadiness {
  const payload = input.latestHeartbeat?.statusPayload ?? null;
  const heartbeatAgeSeconds = input.machine.lastSeenAt
    ? Math.floor((now.getTime() - input.machine.lastSeenAt.getTime()) / 1_000)
    : null;
  const heartbeatFresh =
    input.latestHeartbeat !== null &&
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds <= input.machineHeartbeatTimeoutSeconds;
  const hasProductionPaymentProvider = input.paymentOptions.some(
    (option) => option.providerCode !== "mock" && option.mode === "production",
  );
  const scannerStatus = evidenceStatus(payload, "scannerHealth");
  const scannerOnline = evidenceBoolean(payload, "scannerHealth", "online");
  const productionDispensePathStatus =
    evidenceStatus(payload, "productionDispensePath") ??
    nestedEvidenceStatus(
      payload,
      "saleReadiness",
      "components",
      "productionDispensePath",
    );
  const physicalStockAttestationStatus = evidenceStatus(
    payload,
    "physicalStockAttestation",
  );
  const physicalStockAttestationPlanogramVersion = evidenceString(
    payload,
    "physicalStockAttestation",
    "planogramVersion",
  );
  const platformActiveAcknowledgedPlanogramVersion =
    input.platformPlanogram?.activeAcknowledgedPlanogramVersion ?? null;
  const physicalStockAttestationPlanogramMatches =
    physicalStockAttestationStatus !== "ready" ||
    input.platformPlanogram === undefined ||
    (platformActiveAcknowledgedPlanogramVersion !== null &&
      physicalStockAttestationPlanogramVersion ===
        platformActiveAcknowledgedPlanogramVersion);
  const physicalStockAttestationPlanogramMismatch =
    physicalStockAttestationStatus === "ready" &&
    !physicalStockAttestationPlanogramMatches;
  const physicalStockAttestationReady =
    physicalStockAttestationStatus === "ready" &&
    physicalStockAttestationPlanogramMatches;
  const physicalStockAttestationCode = physicalStockAttestationPlanogramMismatch
    ? "physical_stock_attestation.planogram_mismatch"
    : physicalStockAttestationStatus === "ready"
      ? "physical_stock_attestation.ready"
      : physicalStockAttestationStatus === "stale"
        ? "physical_stock_attestation.stale"
        : physicalStockAttestationStatus === "inconsistent"
          ? "physical_stock_attestation.inconsistent"
          : "physical_stock_attestation.missing";
  const physicalStockAttestationMessage =
    physicalStockAttestationPlanogramMismatch
      ? "Physical Stock Attestation planogram does not match the platform active acknowledged planogram"
      : physicalStockAttestationStatus === "ready"
        ? "Physical Stock Attestation is complete"
        : physicalStockAttestationStatus === "stale"
          ? "Physical Stock Attestation is stale for the active planogram"
          : physicalStockAttestationStatus === "inconsistent"
            ? "Physical Stock Attestation is inconsistent with current machine stock state"
            : "Physical Stock Attestation evidence is missing";
  const recoveryDrillStatus = evidenceStatus(payload, "recoveryDrill");
  const managedMachineUpdateStatus = evidenceStatus(
    payload,
    "managedMachineUpdate",
  );
  const saleReadinessState = evidenceString(payload, "saleReadiness", "state");
  const maintenanceLock = evidenceObject(
    payload,
    "wholeMachineMaintenanceLock",
  );
  const maintenanceLockMessage =
    typeof maintenanceLock?.["message"] === "string"
      ? maintenanceLock["message"]
      : "Whole Machine Maintenance Lock is active";
  const productionDispensePathReady = productionDispensePathStatus === "ready";
  const scannerReady =
    scannerStatus === "online" ||
    scannerStatus === "ready" ||
    scannerOnline === true;

  const checks = [
    check({
      code:
        input.machine.status === "online" && heartbeatFresh
          ? "machine_heartbeat.online"
          : input.latestHeartbeat && heartbeatAgeSeconds !== null
            ? "machine_heartbeat.stale"
            : "machine_heartbeat.missing",
      label: "Online / Last Heartbeat",
      status:
        input.machine.status === "online" && heartbeatFresh
          ? "ready"
          : "blocked",
      message: !input.latestHeartbeat
        ? "Machine is not online or has no heartbeat evidence"
        : heartbeatAgeSeconds === null
          ? "Machine heartbeat receive time is missing"
          : heartbeatFresh
            ? "Machine heartbeat is fresh"
            : "Machine heartbeat timed out",
      operatorAction:
        input.machine.status === "online" && heartbeatFresh
          ? "Continue daily inspection."
          : "Restore machine connectivity and wait for a fresh Machine Heartbeat.",
    }),
    check({
      code:
        saleReadinessState === "restored"
          ? "machine_sale_readiness.restored"
          : "machine_sale_readiness.blocked",
      label: "Machine Sale Readiness",
      status: saleReadinessState === "restored" ? "ready" : "blocked",
      message:
        saleReadinessState === "restored"
          ? "Machine Sale Readiness is restored"
          : "Machine Sale Readiness is not restored",
      operatorAction:
        saleReadinessState === "restored"
          ? "Continue daily inspection."
          : "Resolve sale blockers shown by the machine runtime before production pilot.",
    }),
    check({
      code: hasProductionPaymentProvider
        ? "payment_readiness.ready"
        : "payment_readiness.no_production_provider",
      label: "Payment Readiness",
      status: hasProductionPaymentProvider ? "ready" : "blocked",
      message: hasProductionPaymentProvider
        ? "Payment Readiness has at least one production provider"
        : "Payment Readiness has no production payment provider",
      operatorAction: hasProductionPaymentProvider
        ? "Continue daily inspection."
        : "Enable a real machine payment provider before production pilot.",
    }),
    check({
      code: scannerReady
        ? "scanner_runtime_status.ready"
        : "scanner_runtime_status.missing",
      label: "Scanner Runtime Status",
      status: scannerReady ? "ready" : "degraded",
      message: scannerReady
        ? "Scanner Runtime Status is ready"
        : "Scanner Runtime Status evidence is missing",
      operatorAction: scannerReady
        ? "Continue daily inspection."
        : "Inspect the scanner runtime; QR payment can remain available if payment readiness is ready.",
    }),
    check({
      code: productionDispensePathReady
        ? "production_dispense_path.ready"
        : "production_dispense_path.blocked",
      label: "Production Dispense Path",
      status: productionDispensePathReady ? "ready" : "blocked",
      message: productionDispensePathReady
        ? "Production Dispense Path uses real hardware evidence"
        : "Production Dispense Path is blocked or missing real hardware evidence",
      operatorAction: productionDispensePathReady
        ? "Continue daily inspection."
        : "Restore the real lower-controller path before production pilot.",
    }),
    check({
      code: maintenanceLock
        ? "whole_machine_maintenance_lock.active"
        : "whole_machine_maintenance_lock.clear",
      label: "Whole Machine Maintenance Lock",
      status: maintenanceLock ? "blocked" : "ready",
      message: maintenanceLock
        ? maintenanceLockMessage
        : "Whole Machine Maintenance Lock is clear",
      operatorAction: maintenanceLock
        ? "Clear the maintenance lock only after hardware health is restored and notes are recorded."
        : "Continue daily inspection.",
    }),
    check({
      code: physicalStockAttestationCode,
      label: "Physical Stock Attestation",
      status: physicalStockAttestationReady
        ? "ready"
        : physicalStockAttestationPlanogramMismatch
          ? "blocked"
          : physicalStockAttestationStatus === "stale" ||
              physicalStockAttestationStatus === "inconsistent"
            ? "blocked"
            : "missing",
      message: physicalStockAttestationMessage,
      operatorAction: physicalStockAttestationReady
        ? "Continue daily inspection."
        : physicalStockAttestationPlanogramMismatch
          ? "Apply and acknowledge the platform planogram on the machine, then record a new Physical Stock Attestation."
          : physicalStockAttestationStatus === "stale"
            ? "Record a new physical stock attestation against the active planogram."
            : physicalStockAttestationStatus === "inconsistent"
              ? "Resolve planogram, slot enablement, and local stock ledger inconsistencies before production pilot."
              : "Record physical slot contents through the stock attestation workflow before production pilot.",
    }),
    check({
      code:
        recoveryDrillStatus === "ready"
          ? "recovery_drill.ready"
          : "recovery_drill.missing",
      label: "Recovery Drill",
      status: recoveryDrillStatus === "ready" ? "ready" : "missing",
      message:
        recoveryDrillStatus === "ready"
          ? "Recovery Drill status is complete"
          : "Recovery Drill status is missing",
      operatorAction:
        recoveryDrillStatus === "ready"
          ? "Continue daily inspection."
          : "Complete protected payment and fulfillment Recovery Drills before production pilot.",
    }),
    check({
      code:
        managedMachineUpdateStatus === "ready"
          ? "managed_machine_update.ready"
          : "managed_machine_update.missing",
      label: "Managed Machine Update",
      status: managedMachineUpdateStatus === "ready" ? "ready" : "missing",
      message:
        managedMachineUpdateStatus === "ready"
          ? "Managed Machine Update capability is ready"
          : "Managed Machine Update capability evidence is missing",
      operatorAction:
        managedMachineUpdateStatus === "ready"
          ? "Continue daily inspection."
          : "Verify managed artifact update and rollback capability before production pilot.",
    }),
  ];
  const blockers = checks.filter(
    (item) => item.status === "blocked" || item.status === "missing",
  );
  const degraded = checks.filter((item) => item.status === "degraded");

  return {
    status:
      blockers.length > 0
        ? "blocked"
        : degraded.length > 0
          ? "degraded"
          : "ready",
    checkedAt: now.toISOString(),
    blockers,
    degraded,
    checks,
  };
}
