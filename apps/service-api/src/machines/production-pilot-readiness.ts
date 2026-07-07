import type {
  MachineHeartbeatStatusPayload,
  ProductionPilotReadinessCheck,
  ProductionPilotReadinessDiagnosticContract,
} from "@vem/shared";

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

type ExternalNaturalEnvironmentEvidence = {
  status: "ready" | "stale" | "unavailable" | "unconfigured";
};

export type ProductionPilotReadinessInput = {
  machine: MachineEvidence;
  latestHeartbeat: LatestHeartbeatEvidence;
  paymentOptions: PaymentOptionEvidence[];
  machineHeartbeatTimeoutSeconds: number;
  platformPlanogram?: PlatformPlanogramEvidence;
  externalNaturalEnvironment?: ExternalNaturalEnvironmentEvidence;
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

function saleReadinessState(
  value: string | null,
): "locked" | "blocked" | "restored" | null {
  if (value === "locked" || value === "blocked" || value === "restored") {
    return value;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function check(
  input: ProductionPilotReadinessCheck,
): ProductionPilotReadinessCheck {
  return input;
}

export function evaluateProductionPilotReadiness(
  input: ProductionPilotReadinessInput,
  now = new Date(),
): ProductionPilotReadinessDiagnosticContract {
  const payload = input.latestHeartbeat?.statusPayload ?? null;
  const heartbeatAgeSeconds = input.machine.lastSeenAt
    ? Math.floor((now.getTime() - input.machine.lastSeenAt.getTime()) / 1_000)
    : null;
  const heartbeatFresh =
    input.latestHeartbeat !== null &&
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds <= input.machineHeartbeatTimeoutSeconds;
  const productionProviderCount = input.paymentOptions.filter(
    (option) => option.providerCode !== "mock" && option.mode === "production",
  ).length;
  const hasProductionPaymentProvider = productionProviderCount > 0;
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
  const recoveryDrillStatus = evidenceStatus(payload, "recoveryDrill");
  const managedMachineUpdateStatus = evidenceStatus(
    payload,
    "managedMachineUpdate",
  );
  const saleReadiness = evidenceObject(payload, "saleReadiness");
  const currentSaleReadinessState = saleReadinessState(
    evidenceString(payload, "saleReadiness", "state"),
  );
  const saleReadinessBlockingCodes = stringArray(
    saleReadiness?.["blockingCodes"],
  );
  const maintenanceLock = evidenceObject(
    payload,
    "wholeMachineMaintenanceLock",
  );
  const productionDispensePathReady = productionDispensePathStatus === "ready";
  const scannerReady =
    scannerStatus === "online" ||
    scannerStatus === "ready" ||
    scannerOnline === true;
  const externalNaturalEnvironmentStatus =
    input.externalNaturalEnvironment?.status ?? "unconfigured";
  const naturalContextReady =
    externalNaturalEnvironmentStatus === "ready" ||
    externalNaturalEnvironmentStatus === "stale";
  const machineHeartbeatReasonCode =
    input.machine.status === "online" && heartbeatFresh
      ? "online"
      : input.latestHeartbeat && heartbeatAgeSeconds !== null
        ? "stale"
        : "missing";
  const physicalStockAttestationReasonCode =
    physicalStockAttestationPlanogramMismatch
      ? "planogram_mismatch"
      : physicalStockAttestationStatus === "ready"
        ? "ready"
        : physicalStockAttestationStatus === "stale"
          ? "stale"
          : physicalStockAttestationStatus === "inconsistent"
            ? "inconsistent"
            : "missing";

  const checks = [
    check({
      kind: "machine_heartbeat",
      reasonCode: machineHeartbeatReasonCode,
      status:
        input.machine.status === "online" && heartbeatFresh
          ? "ready"
          : "blocked",
      actionCode:
        input.machine.status === "online" && heartbeatFresh
          ? "continue_daily_inspection"
          : "restore_connectivity",
      evidence: {
        machineStatus: input.machine.status,
        heartbeatAgeSeconds,
        timeoutSeconds: input.machineHeartbeatTimeoutSeconds,
        latestHeartbeatReportedAt: input.latestHeartbeat?.reportedAt
          ? input.latestHeartbeat.reportedAt.toISOString()
          : null,
        lastSeenAt: input.machine.lastSeenAt
          ? input.machine.lastSeenAt.toISOString()
          : null,
      },
    }),
    check({
      kind: "machine_sale_readiness",
      reasonCode:
        currentSaleReadinessState === "restored" ? "restored" : "blocked",
      status: currentSaleReadinessState === "restored" ? "ready" : "blocked",
      actionCode:
        currentSaleReadinessState === "restored"
          ? "continue_daily_inspection"
          : "resolve_machine_sale_blockers",
      evidence: {
        saleReadinessState: currentSaleReadinessState,
        blockingCodes: saleReadinessBlockingCodes,
      },
    }),
    check({
      kind: "payment_readiness",
      reasonCode: hasProductionPaymentProvider
        ? "ready"
        : "no_production_provider",
      status: hasProductionPaymentProvider ? "ready" : "blocked",
      actionCode: hasProductionPaymentProvider
        ? "continue_daily_inspection"
        : "enable_production_payment_provider",
      evidence: { productionProviderCount },
    }),
    check({
      kind: "scanner_runtime_status",
      reasonCode: scannerReady ? "ready" : "missing",
      status: scannerReady ? "ready" : "degraded",
      actionCode: scannerReady
        ? "continue_daily_inspection"
        : "inspect_scanner_runtime",
      evidence: { scannerStatus, scannerOnline },
    }),
    check({
      kind: "natural_context_readiness",
      reasonCode: naturalContextReady
        ? externalNaturalEnvironmentStatus
        : externalNaturalEnvironmentStatus,
      status: naturalContextReady ? "ready" : "degraded",
      actionCode: naturalContextReady
        ? "continue_daily_inspection"
        : externalNaturalEnvironmentStatus === "unconfigured"
          ? "configure_machine_geo_location"
          : "inspect_external_natural_environment",
      evidence: { externalNaturalEnvironmentStatus },
    }),
    check({
      kind: "production_dispense_path",
      reasonCode: productionDispensePathReady ? "ready" : "blocked",
      status: productionDispensePathReady ? "ready" : "blocked",
      actionCode: productionDispensePathReady
        ? "continue_daily_inspection"
        : "restore_real_lower_controller_path",
      evidence: { productionDispensePathStatus },
    }),
    check({
      kind: "whole_machine_maintenance_lock",
      reasonCode: maintenanceLock ? "active" : "clear",
      status: maintenanceLock ? "blocked" : "ready",
      actionCode: maintenanceLock
        ? "clear_maintenance_lock_after_recovery"
        : "continue_daily_inspection",
      evidence: {
        active: maintenanceLock !== null,
        lockCode: nullableString(maintenanceLock?.["code"]),
        slotCode: nullableString(maintenanceLock?.["slotCode"]),
        commandNo: nullableString(maintenanceLock?.["commandNo"]),
      },
    }),
    check({
      kind: "physical_stock_attestation",
      reasonCode: physicalStockAttestationReasonCode,
      status: physicalStockAttestationReady
        ? "ready"
        : physicalStockAttestationPlanogramMismatch
          ? "blocked"
          : physicalStockAttestationStatus === "stale" ||
              physicalStockAttestationStatus === "inconsistent"
            ? "blocked"
            : "missing",
      actionCode: physicalStockAttestationReady
        ? "continue_daily_inspection"
        : physicalStockAttestationPlanogramMismatch
          ? "apply_planogram_then_attest_stock"
          : physicalStockAttestationStatus === "stale"
            ? "record_active_planogram_stock_attestation"
            : physicalStockAttestationStatus === "inconsistent"
              ? "resolve_stock_state_inconsistencies"
              : "record_physical_stock_attestation",
      evidence: {
        attestationStatus: physicalStockAttestationStatus,
        attestationPlanogramVersion: physicalStockAttestationPlanogramVersion,
        activeAcknowledgedPlanogramVersion:
          platformActiveAcknowledgedPlanogramVersion,
        planogramMatches: physicalStockAttestationPlanogramMatches,
      },
    }),
    check({
      kind: "recovery_drill",
      reasonCode: recoveryDrillStatus === "ready" ? "ready" : "missing",
      status: recoveryDrillStatus === "ready" ? "ready" : "missing",
      actionCode:
        recoveryDrillStatus === "ready"
          ? "continue_daily_inspection"
          : "complete_recovery_drills",
      evidence: { recoveryDrillStatus },
    }),
    check({
      kind: "managed_machine_update",
      reasonCode: managedMachineUpdateStatus === "ready" ? "ready" : "missing",
      status: managedMachineUpdateStatus === "ready" ? "ready" : "missing",
      actionCode:
        managedMachineUpdateStatus === "ready"
          ? "continue_daily_inspection"
          : "verify_managed_update_and_rollback",
      evidence: { managedMachineUpdateStatus },
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
