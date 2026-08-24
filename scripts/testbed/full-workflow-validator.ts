import type { CapturedSourceEvidence } from "./framework/slices/vision-experience/captured-source-evidence.ts";

import {
  capturedSourceBinding,
  hasSameCapturedEvidenceValue,
  normalizeVisionOrigin,
  validateCapturedSourceEvidence,
} from "./framework/slices/vision-experience/captured-source-evidence.ts";
import { validatePaymentRecoveryEvidence } from "./payment-recovery-guest-full.ts";
import { validatePresenceAndAudioGuestReport } from "./presence-and-audio-guest-full.ts";
import { validateStockMaintenanceReport } from "./stock-maintenance-guest-full.ts";

type JsonRecord = Record<string, unknown>;

interface TrackResult extends JsonRecord {
  key: string;
  label: string;
  status: string;
  reportPath: string | null;
  reason: string | null;
  details: JsonRecord | null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function maybeRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function trackResult({
  key,
  label,
  status,
  reportPath = null,
  details = null,
  reason = null,
}: {
  key: string;
  label: string;
  status: string;
  reportPath?: string | null;
  details?: JsonRecord | null;
  reason?: string | null;
}): TrackResult {
  return {
    key,
    label,
    status,
    reportPath,
    reason,
    details,
  };
}

function failedTrack(
  key: string,
  label: string,
  reportPath: string | null | undefined,
  reason: string,
  details: JsonRecord | null | undefined = null,
): TrackResult {
  return trackResult({
    key,
    label,
    status: "failed",
    reportPath,
    reason,
    details,
  });
}

function passedTrack(
  key: string,
  label: string,
  reportPath: string | null | undefined,
  details: JsonRecord | null | undefined = null,
): TrackResult {
  return trackResult({
    key,
    label,
    status: "passed",
    reportPath,
    details,
  });
}

function validateFastTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-fast-route-stress-sale/v2" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "standardSale",
      "standard sale",
      reportPath,
      "fast route stress sale did not finish successfully",
    );
  }
  const summary = recordValue(report.summary);
  if (
    !summary.orderId ||
    !summary.paymentId ||
    !summary.vendingCommandId ||
    JSON.stringify(summary.protocol) !==
      JSON.stringify(["VEND", "F0", "F1", "F2"]) ||
    summary.daemonStockDeltaAfterF2 !== -1 ||
    summary.platformStockDeltaAfterF2 !== -1 ||
    typeof summary.visionEventId !== "string" ||
    !Number.isInteger(summary.repeatedPhysicalTouchTraceId)
  ) {
    return failedTrack(
      "standardSale",
      "standard sale",
      reportPath,
      "fast route summary is incomplete",
      summary,
    );
  }
  return passedTrack("standardSale", "standard sale", reportPath, {
    orderId: summary.orderId,
    paymentId: summary.paymentId,
    vendingCommandId: summary.vendingCommandId,
    protocol: summary.protocol,
    visionEventId: summary.visionEventId,
    repeatedPhysicalTouchTraceId: summary.repeatedPhysicalTouchTraceId,
  });
}

function validateDelayedAudioTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  const acceptance = maybeRecord(report?.delayedPickupNativeAudio);
  const audio = recordValue(acceptance?.audio);
  const controller = recordValue(acceptance?.controller);
  const capture = recordValue(audio.capture);
  if (
    report?.schemaVersion !== "local-testbed-delayed-pickup-native-audio/v1" ||
    report?.ok !== true ||
    acceptance?.schemaVersion !==
      "delayed-pickup-native-audio-production-acceptance/v3" ||
    acceptance?.result !== "passed"
  ) {
    return failedTrack(
      "audio",
      "audio",
      reportPath,
      "delayed pickup native audio acceptance did not pass",
    );
  }
  const cueWindows = arrayValue(audio.cueWindows);
  const cueStartLatencyMs = recordValue(controller.cueStartLatencyMs);
  const requiredCues = ["pickup_started", "ordinary_warning", "urgent_warning"];
  return audio?.source === "windows_default_output" &&
    cueWindows.length > 0 &&
    cueWindows.every(
      (entry: unknown) => recordValue(entry).kind === "passed",
    ) &&
    requiredCues.every((cue) => {
      const latency = cueStartLatencyMs[cue];
      return (
        typeof latency === "number" &&
        Number.isFinite(latency) &&
        latency >= 0 &&
        latency <= 2_000
      );
    }) &&
    Number(capture.nonSilentFrameCount) > 0 &&
    Number(capture.peakAbsoluteSample) > 0
    ? passedTrack("audio", "audio", reportPath, {
        cueCount: requiredCues.length,
        source: audio.source,
      })
    : failedTrack(
        "audio",
        "audio",
        reportPath,
        "audio cue windows are incomplete",
        audio ?? null,
      );
}

function validatePresenceAndAudioTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  try {
    const summary = validatePresenceAndAudioGuestReport(report) as JsonRecord;
    const categoryTransitions = arrayValue(summary.categoryTransitions);
    return passedTrack("presenceAndAudio", "presence and audio", reportPath, {
      welcomeTransitions: summary.welcomeTransitions,
      categoryTransitions: categoryTransitions.map(
        (entry: unknown) => recordValue(entry).key,
      ),
      nativeSource: summary.nativeSource,
    });
  } catch (error) {
    return failedTrack(
      "presenceAndAudio",
      "presence and audio",
      reportPath,
      error instanceof Error
        ? error.message
        : "presence and audio evidence is incomplete",
      maybeRecord(report?.presenceAndAudio) ?? report ?? null,
    );
  }
}

function validateStartupTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  const summary = recordValue(report?.summary);
  const modeEvidence = recordValue(summary.modeEvidence);
  const visionReadiness = recordValue(summary.visionReadiness);
  const visionCapabilities = arrayValue(visionReadiness.capabilities);
  const fullEvidenceComplete =
    report?.mode !== "full" ||
    (modeEvidence.source === "windows_reboot_logon_probe" &&
      typeof modeEvidence.bootMarker === "string" &&
      modeEvidence.bootMarker.length > 0 &&
      typeof modeEvidence.logonMarker === "string" &&
      modeEvidence.logonMarker.length > 0 &&
      typeof modeEvidence.bootObservedAt === "string" &&
      typeof modeEvidence.logonObservedAt === "string");
  if (
    report?.schemaVersion !== "vem-installed-runtime-startup-acceptance/v1" ||
    report?.ok !== true ||
    summary.daemonService !== "VemVendingDaemon" ||
    summary.machineUiTask !== "VEMMachineUI" ||
    summary.visionTask !== "VEMVisionRuntime" ||
    !Number.isSafeInteger(summary.kioskSessionId) ||
    (summary.kioskSessionId as number) < 1 ||
    summary.catalogRoute !== "#/catalog" ||
    visionReadiness.protocol !== "vem.vision.v2" ||
    visionReadiness.cameraReady !== true ||
    visionReadiness.tryOnReady !== true ||
    visionReadiness.visionBusinessReady !== true ||
    !/^[a-f0-9]{64}$/.test(String(visionReadiness.contractDigest ?? "")) ||
    !["profile_push", "presence_status", "person_departed", "try_on"].every(
      (capability) => visionCapabilities.includes(capability),
    ) ||
    !fullEvidenceComplete
  ) {
    return failedTrack(
      "startup",
      "startup",
      reportPath,
      "installed startup-owner readiness evidence is incomplete",
      report ?? null,
    );
  }
  return passedTrack("startup", "startup", reportPath, summary);
}

function validateScannerTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-scanner-payment-code-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "scannerPayment",
      "scanner payment",
      reportPath,
      "scanner payment-code acceptance did not finish successfully",
    );
  }
  const invalidScan = maybeRecord(report.invalidScanEvidence);
  const malformed = recordValue(invalidScan?.malformed);
  const timeout = recordValue(invalidScan?.timeout);
  const final = maybeRecord(report.final);
  const finalResult = recordValue(final?.result);
  const platformAssertions = maybeRecord(report.platformAssertions);
  const platformAttempt = recordValue(platformAssertions?.attempt);
  const renderedSale = maybeRecord(report.renderedSale);
  const scannerAttempt = maybeRecord(report.scannerAttempt);
  const orderId = renderedSale?.orderId ?? finalResult.orderId;
  const paymentId = renderedSale?.paymentId ?? finalResult.paymentId;
  const orderNo = renderedSale?.orderNo ?? finalResult.orderNo;
  const scanner =
    orderId &&
    paymentId &&
    orderNo &&
    scannerAttempt?.source === "serial_text" &&
    platformAttempt.status === "succeeded" &&
    platformAssertions?.movement &&
    finalResult.kind === "success"
      ? passedTrack("scannerPayment", "scanner payment", reportPath, {
          orderId,
          paymentId,
          orderNo,
          scannerEventId:
            platformAttempt.scannerEventId ??
            scannerAttempt?.scannerEventId ??
            null,
        })
      : failedTrack(
          "scannerPayment",
          "scanner payment",
          reportPath,
          "scanner payment-code success path is incomplete",
          {
            renderedSale,
            scannerAttempt,
            platformAssertions,
            final,
          },
        );
  if (
    malformed.attemptCount !== 0 ||
    malformed.paymentDelta !== 0 ||
    timeout.attemptCount !== 0 ||
    timeout.paymentDelta !== 0
  ) {
    return failedTrack(
      "scannerPayment",
      "scanner payment",
      reportPath,
      "scanner malformed/timeout evidence is incomplete",
      { malformed, timeout },
    );
  }
  return scanner;
}

function validateIpcRecoveryTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-installed-ipc-recovery-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "ipcRecovery",
      "IPC recovery",
      reportPath,
      "installed IPC recovery track did not finish successfully",
    );
  }
  const cleanup = maybeRecord(report.cleanup);
  const ipcRecovery = maybeRecord(report.ipcRecovery);
  const assertions = recordValue(ipcRecovery?.assertions);
  const evidence = recordValue(ipcRecovery?.evidence);
  const result = maybeRecord(report.result);
  const renderedSale = maybeRecord(report.renderedSale);
  const liveSale = maybeRecord(report.liveSale);
  if (
    cleanup?.ok !== true ||
    evidence?.status !== "passed" ||
    assertions?.overlayObserved !== true ||
    assertions?.retainedOrderCredential !== renderedSale?.orderNo ||
    assertions?.resumedOrderCredential !== renderedSale?.orderNo ||
    assertions?.daemonTransportPhase !== "recovered" ||
    result?.kind !== "success" ||
    liveSale?.vendingCommandId == null
  ) {
    return failedTrack(
      "ipcRecovery",
      "IPC recovery",
      reportPath,
      "installed IPC recovery evidence is incomplete",
      {
        renderedSale,
        assertions,
        evidence,
        result,
        cleanup,
      },
    );
  }
  return passedTrack("ipcRecovery", "IPC recovery", reportPath, {
    orderNo: renderedSale?.orderNo,
    vendingCommandId: liveSale?.vendingCommandId,
  });
}

function validateFulfillmentFailureTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-serial-fulfillment-error-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "fulfillmentRecovery",
      "fulfillment recovery",
      reportPath,
      "serial fulfillment failure track did not finish successfully",
    );
  }
  const cleanup = maybeRecord(report.cleanup);
  const assertions = recordValue(report.assertions);
  const paymentCompletion = maybeRecord(report.paymentCompletion);
  if (
    cleanup?.error ||
    assertions?.inventoryDelta !== 0 ||
    !["refund_pending", "refunded", "manual_handling"].includes(
      String(assertions?.orderStatus ?? ""),
    ) ||
    assertions?.commandId == null ||
    paymentCompletion == null
  ) {
    return failedTrack(
      "fulfillmentRecovery",
      "fulfillment recovery",
      reportPath,
      "post-payment fulfillment failure evidence is incomplete",
      {
        assertions,
        cleanup,
        paymentCompletion,
      },
    );
  }
  return passedTrack(
    "fulfillmentRecovery",
    "fulfillment recovery",
    reportPath,
    {
      orderStatus: assertions.orderStatus,
      commandId: assertions.commandId,
      inventoryDelta: assertions.inventoryDelta,
    },
  );
}

function validatePaymentRecoveryTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  try {
    const summary = validatePaymentRecoveryEvidence(report) as JsonRecord;
    return passedTrack(
      "paymentRecovery",
      "payment recovery",
      reportPath,
      summary,
    );
  } catch (error) {
    return failedTrack(
      "paymentRecovery",
      "payment recovery",
      reportPath,
      "payment recovery evidence is incomplete",
      {
        payment: report?.payment ?? null,
        assertions: report?.assertions ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function validatePaymentProviderTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  const environment = recordValue(report?.environment);
  const authoritative = maybeRecord(report?.authoritative);
  const provider = maybeRecord(report?.provider);
  const providerIdentity = maybeRecord(provider?.identity);
  const hostPreparation = recordValue(provider?.hostPreparation);
  if (
    report?.schemaVersion !== "vem-payment-provider-guest-full/v1" ||
    report?.ok !== true ||
    report?.outcome !== "passed" ||
    environment?.environment !== "sandbox" ||
    environment?.readiness !== "ready" ||
    authoritative?.ok !== true
  ) {
    return failedTrack(
      "paymentProvider",
      "payment provider",
      reportPath,
      "payment provider boundary did not finish successfully",
      report ?? null,
    );
  }
  const attempts = arrayValue(authoritative?.attempts);
  const qr = attempts.find(
    (attempt: unknown) => recordValue(attempt).channel === "qr_code:alipay",
  ) as JsonRecord | undefined;
  const code = attempts.find(
    (attempt: unknown) =>
      recordValue(attempt).channel === "payment_code:alipay",
  ) as JsonRecord | undefined;
  const terminalClean = (attempt: JsonRecord | undefined): boolean => {
    const terminal = recordValue(attempt?.terminal);
    return (
      terminal?.reservedInventory === false &&
      (["failed", "canceled", "expired"].includes(
        String(terminal?.paymentStatus ?? ""),
      ) ||
        (terminal?.paymentStatus === "unknown" &&
          terminal?.orderStatus === "manual_handling"))
    );
  };
  const qrOrder = recordValue(qr?.order);
  const qrMachine = recordValue(qr?.machine);
  const qrSurface = recordValue(qrMachine.surface);
  const qrCredential = recordValue(qr?.credential);
  const qrQuery = recordValue(qr?.query);
  const qrClosure = recordValue(qr?.closure);
  const qrTerminal = recordValue(qr?.terminal);
  const qrValid =
    qrOrder?.providerCode === "alipay" &&
    qrMachine?.boundary === "installed_machine_ui_cdp" &&
    qrMachine?.paymentMethod === "qr_code" &&
    qrMachine?.providerCode === "alipay" &&
    qrSurface?.orderId === qrOrder?.orderId &&
    qrSurface?.paymentId === qrOrder?.paymentId &&
    qrSurface?.orderNo === qrOrder?.orderNo &&
    String(qrCredential?.paymentUrlSha256 ?? "").startsWith("sha256:") &&
    typeof qrQuery?.reconciliationAttemptId === "string" &&
    qrQuery.reconciliationAttemptId.length > 0 &&
    qrQuery?.providerCode === "alipay" &&
    qrQuery?.status === "provider_trade_not_exist" &&
    qrQuery?.providerPaymentStatus === "pending" &&
    qrClosure?.action === "close_or_reverse_uncertain_payment" &&
    qrClosure?.handled === true &&
    typeof qrClosure?.providerConfigId === "string" &&
    qrClosure.providerConfigId === providerIdentity?.providerConfigId &&
    (["canceled", "expired"].includes(
      String(qrTerminal?.paymentStatus ?? ""),
    ) ||
      (qrTerminal?.paymentStatus === "unknown" &&
        qrTerminal?.orderStatus === "manual_handling")) &&
    terminalClean(qr);
  const codeOrder = recordValue(code?.order);
  const codeMachine = recordValue(code?.machine);
  const codeSurface = recordValue(codeMachine.surface);
  const codeSubmission = recordValue(code?.submission);
  const codeCleanup = recordValue(code?.cleanup);
  const codeCleanupClosure = recordValue(codeCleanup.closure);
  const codeSerialSession = recordValue(codeCleanup.serialSession);
  const codeValid =
    codeOrder?.providerCode === "alipay" &&
    codeMachine?.boundary === "installed_machine_ui_cdp" &&
    codeMachine?.paymentMethod === "payment_code" &&
    codeMachine?.providerCode === "alipay" &&
    codeSurface?.orderId === codeOrder?.orderId &&
    codeSurface?.paymentId === codeOrder?.paymentId &&
    codeSurface?.orderNo === codeOrder?.orderNo &&
    String(codeMachine?.scannerPrompt ?? "").includes("请出示付款码") &&
    codeSubmission?.providerCode === "alipay" &&
    typeof codeSubmission?.attemptId === "string" &&
    codeSubmission.attemptId.length > 0 &&
    ["failed", "querying", "user_confirming"].includes(
      String(codeSubmission?.status ?? ""),
    ) &&
    (codeSubmission?.status !== "failed" ||
      (typeof codeSubmission?.failureCode === "string" &&
        codeSubmission.failureCode.length > 0)) &&
    (codeSubmission?.status !== "user_confirming" ||
      codeSubmission?.providerStatus === "WAIT_BUYER_PAY") &&
    (codeSubmission?.status !== "querying" ||
      ["aop.ACQ.SYSTEM_ERROR", "PAYMENT_CODE_QUERY_UNKNOWN"].includes(
        String(codeSubmission?.failureCode ?? ""),
      )) &&
    typeof codeSubmission?.providerStatus === "string" &&
    codeSubmission.providerStatus.length > 0 &&
    codeCleanup?.action === "close_or_reverse_uncertain_payment" &&
    (codeCleanupClosure?.handled === true || terminalClean(code)) &&
    codeSerialSession?.action === "abort" &&
    codeSerialSession?.aborted === true &&
    typeof codeCleanup?.providerConfigId === "string" &&
    codeCleanup.providerConfigId === providerIdentity?.providerConfigId &&
    terminalClean(code);
  const providerPrepared =
    providerIdentity?.providerCode === "alipay" &&
    typeof providerIdentity?.providerConfigId === "string" &&
    providerIdentity.providerConfigId.length > 0 &&
    typeof providerIdentity?.appId === "string" &&
    providerIdentity.appId.length > 0 &&
    typeof providerIdentity?.merchantNo === "string" &&
    providerIdentity.merchantNo.length > 0 &&
    providerIdentity?.mode === "sandbox" &&
    providerIdentity?.keyType === "PKCS1" &&
    providerIdentity?.gatewayUrl ===
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do" &&
    hostPreparation?.source === "host_installation_fixture" &&
    hostPreparation?.preflight === "configured";
  const uniqueOrders = new Set(
    attempts
      .map(
        (attempt: unknown) => recordValue(recordValue(attempt).order).orderId,
      )
      .filter(Boolean),
  );
  const diagnostics = arrayValue(report.diagnostics);
  if (
    attempts.length !== 2 ||
    uniqueOrders.size !== 2 ||
    !providerPrepared ||
    !qrValid ||
    !codeValid ||
    diagnostics.length > 2
  ) {
    return failedTrack(
      "paymentProvider",
      "payment provider",
      reportPath,
      "payment provider evidence must prove only cleaned, non-paid Alipay attempts",
      { attempts: attempts ?? null, diagnostics },
    );
  }
  return passedTrack("paymentProvider", "payment provider", reportPath, {
    qrOrderId: qrOrder.orderId,
    paymentCodeOrderId: codeOrder.orderId,
    diagnosticAttempts: diagnostics.length,
  });
}

function validateStockMaintenanceTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  try {
    const summary = validateStockMaintenanceReport(report) as JsonRecord;
    return passedTrack(
      "stockMaintenance",
      "stock maintenance",
      reportPath,
      summary,
    );
  } catch (error) {
    return failedTrack(
      "stockMaintenance",
      "stock maintenance",
      reportPath,
      error instanceof Error
        ? error.message
        : "stock maintenance evidence must prove the installed 1-to-0-to-2-to-1 loop",
      report ?? null,
    );
  }
}

function validateLocalOperationsTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-local-operations-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "localOperations",
      "local operations",
      reportPath,
      "local operations track did not finish successfully",
    );
  }
  const boundaries = maybeRecord(report.boundaries);
  const planogram = maybeRecord(report.planogram);
  const manualDispense = maybeRecord(report.manualDispense);
  const localEnvironmentControl = maybeRecord(report.localEnvironmentControl);
  const localEnvironmentRequest = recordValue(localEnvironmentControl?.request);
  const localEnvironmentAction = recordValue(localEnvironmentRequest?.action);
  const localEnvironmentAdmission = recordValue(
    localEnvironmentControl?.admission,
  );
  const localEnvironmentSnapshot = recordValue(
    localEnvironmentControl?.snapshot,
  );
  const localEnvironmentFrame = recordValue(
    localEnvironmentControl?.protocolFrame,
  );
  const maintenanceEntry = maybeRecord(report.maintenanceEntry);
  const maintenanceEntries = arrayValue(maintenanceEntry?.entries);
  const maintenanceTaskReturns = arrayValue(maintenanceEntry?.taskReturns);
  if (
    boundaries?.daemon !== true ||
    boundaries?.hardwareSelfCheck !== true ||
    boundaries?.serial !== true ||
    planogram?.canonical !== true ||
    !planogram?.planogramVersion ||
    !planogram?.slotId ||
    !planogram?.slotDisplayLabel ||
    !["completed", "failed", "result_unknown"].includes(
      String(manualDispense?.outcome ?? ""),
    ) ||
    manualDispense?.slotId !== planogram.slotId ||
    localEnvironmentRequest?.source !== "local_operator" ||
    localEnvironmentAction?.type !== "set_base_vent_speed" ||
    localEnvironmentAction?.ventSpeed !== 3 ||
    localEnvironmentAdmission?.outcome !== "accepted" ||
    !Number.isInteger(localEnvironmentAdmission?.acceptedRevision) ||
    recordValue(localEnvironmentSnapshot.settings).baseVentSpeed !== 3 ||
    recordValue(localEnvironmentSnapshot.desired).ventSpeed !== 3 ||
    localEnvironmentSnapshot.convergence !== "applied" ||
    localEnvironmentFrame?.parsedOpcode !== "B3" ||
    maintenanceEntries.length < 1 ||
    maintenanceEntries.some(
      (entry: unknown) =>
        recordValue(entry).ok !== true ||
        recordValue(entry).finalRoute !== "#/maintenance?source=operator",
    ) ||
    !maintenanceEntries.some(
      (entry: unknown) => recordValue(entry).route === "#/catalog",
    ) ||
    maintenanceTaskReturns.length < 1 ||
    maintenanceTaskReturns.some(
      (entry: unknown) =>
        recordValue(entry).ok !== true ||
        recordValue(entry).finalRoute !== "#/catalog",
    )
  ) {
    return failedTrack(
      "localOperations",
      "local operations",
      reportPath,
      "local operations evidence is incomplete",
      {
        boundaries,
        planogram,
        manualDispense,
        localEnvironmentControl,
      },
    );
  }
  return passedTrack("localOperations", "local operations", reportPath, {
    slotId: planogram?.slotId,
    slotDisplayLabel: planogram?.slotDisplayLabel,
    planogramVersion: planogram?.planogramVersion,
    manualOutcome: manualDispense?.outcome,
    localVentSpeed: localEnvironmentAction?.ventSpeed,
  });
}

function validateHardwareLifecycleTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-hardware-lifecycle-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "hardwareLifecycle",
      "hardware lifecycle",
      reportPath,
      "hardware lifecycle track did not finish successfully",
    );
  }
  const discovery = recordValue(report.discovery);
  const readiness = recordValue(report.readiness);
  const readinessBefore = recordValue(readiness.before);
  const readinessAfter = recordValue(readiness.after);
  const lifecycle = arrayValue(report.lifecycle);
  const lifecycleRecords = lifecycle.map((entry: unknown) =>
    recordValue(entry),
  );
  const byRole = new Map(lifecycleRecords.map((entry) => [entry.role, entry]));
  const lower = maybeRecord(byRole.get("lower_controller"));
  const scanner = maybeRecord(byRole.get("scanner"));
  const roles = arrayValue(discovery.roles);
  const qemuMappings = arrayValue(discovery.qemuUsbSerialMappings);
  const stableReadiness =
    readinessBefore?.canStartSale === true &&
    readinessAfter?.canStartSale === true &&
    Number.isInteger(readinessBefore?.revision) &&
    Number.isInteger(readinessAfter?.revision) &&
    (readinessAfter.revision as number) >= (readinessBefore.revision as number);
  const validLifecycle = [lower, scanner].every((entry: JsonRecord | null) => {
    const disconnect = recordValue(entry?.disconnect);
    const disconnectBoundary = recordValue(disconnect.boundary);
    const disconnectDaemon = recordValue(disconnect.daemon);
    const reconnect = recordValue(entry?.reconnect);
    const reconnectBoundary = recordValue(reconnect.boundary);
    const reconnectDaemon = recordValue(reconnect.daemon);
    return (
      disconnectBoundary?.adapter === "file_backed_windows_pnp" &&
      disconnectBoundary.operation === "disconnect" &&
      disconnectBoundary.identityKey === entry?.identityKey &&
      disconnectDaemon?.ready === false &&
      disconnectDaemon?.currentPort == null &&
      reconnectBoundary?.adapter === "file_backed_windows_pnp" &&
      reconnectBoundary.operation === "reconnect" &&
      reconnectBoundary.identityKey === entry?.identityKey &&
      reconnectDaemon?.ready === true &&
      typeof reconnectDaemon?.currentPort === "string" &&
      reconnectDaemon.identityKey === entry?.identityKey
    );
  });
  const lowerDisconnectCapability = recordValue(
    recordValue(lower?.disconnect).saleStartCapability,
  );
  const lowerReconnectCapability = recordValue(
    recordValue(lower?.reconnect).saleStartCapability,
  );
  const lowerCapabilityValid =
    lowerDisconnectCapability?.canStartSale === false &&
    lowerReconnectCapability?.canStartSale === true;
  const scannerPaymentOptions = (capability: unknown) =>
    arrayValue(
      recordValue(recordValue(capability).paymentOptions).options,
    ).filter(
      (option: unknown) => recordValue(option).method === "payment_code",
    );
  const scannerDisconnectOptions = scannerPaymentOptions(
    recordValue(scanner?.disconnect).saleStartCapability,
  );
  const scannerReconnectOptions = scannerPaymentOptions(
    recordValue(scanner?.reconnect).saleStartCapability,
  );
  const scannerCapabilityValid =
    scannerDisconnectOptions.length > 0 &&
    scannerDisconnectOptions.every(
      (option: unknown) => recordValue(option).ready === false,
    ) &&
    scannerReconnectOptions.some(
      (option: unknown) => recordValue(option).ready === true,
    );
  if (
    roles.length < 2 ||
    qemuMappings.length < 2 ||
    discovery.dynamicRoleDiscovery !== true ||
    discovery.fixedComSelection !== false ||
    stableReadiness !== true ||
    validLifecycle !== true ||
    lowerCapabilityValid !== true ||
    scannerCapabilityValid !== true
  ) {
    return failedTrack(
      "hardwareLifecycle",
      "hardware lifecycle",
      reportPath,
      "hardware lifecycle evidence is incomplete",
      { discovery, readiness, lifecycle },
    );
  }
  return passedTrack("hardwareLifecycle", "hardware lifecycle", reportPath, {
    roles: roles.map((role: unknown) => recordValue(role).role),
    readinessRevision: readinessAfter.revision,
    lifecycleRoles: lifecycleRecords.map((entry) => entry.role),
  });
}

function validateEnvironmentControlTrack(
  report: JsonRecord,
  reportPath: string,
): TrackResult {
  if (
    report?.schemaVersion !== "vem-environment-control-guest-full/v2" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "environmentControl",
      "environment control",
      reportPath,
      "environment control track did not finish successfully",
    );
  }
  const commands = arrayValue(report.commands);
  const commandRecords = commands.map((entry: unknown) => recordValue(entry));
  const requiredActions = [
    "airConditionerOnTrue",
    "airConditionerOnFalse",
    "ventSpeed",
    "targetTemperatureCelsius",
  ];
  const validCommand = (entry: JsonRecord): boolean => {
    const admin = recordValue(entry?.admin);
    const result = recordValue(entry?.result);
    const resultJson = recordValue(result.resultJson);
    const mqtt = recordValue(entry?.mqtt);
    const serial = recordValue(entry?.serial);
    const snapshot = recordValue(entry?.snapshot);
    return (
      typeof admin?.commandNo === "string" &&
      admin.commandNo.length > 0 &&
      admin?.status === "sent" &&
      result?.status === "succeeded" &&
      ["accepted", "deduplicated"].includes(String(resultJson?.outcome)) &&
      Number.isInteger(resultJson?.acceptedRevision) &&
      snapshot?.revision === resultJson.acceptedRevision &&
      snapshot?.convergence === "applied" &&
      mqtt?.commandObserved === true &&
      mqtt?.resultObserved === true &&
      mqtt?.commandNo === admin.commandNo &&
      mqtt?.resultCommandNo === admin.commandNo &&
      serial?.lowerBoundaryObserved === true &&
      serial?.protocolFrameObserved === true &&
      recordValue(serial?.protocolFrame).parsedOpcode === serial?.expectedOpcode
    );
  };
  const hasRequiredActions = requiredActions.every((action) =>
    commandRecords.some(
      (entry) => entry.action === action && validCommand(entry),
    ),
  );
  const sessionReplacement = recordValue(report.serialSessionReplacement);
  const replacementSessionId =
    sessionReplacement.replacementControlPlaneSessionId;
  const axisIndependence = recordValue(report.axisIndependence);
  const axisSnapshots = arrayValue(axisIndependence.snapshots).map((entry) =>
    recordValue(entry),
  );
  const persistentZero = recordValue(report.persistentZero);
  const persistentZeroSnapshot = recordValue(
    recordValue(persistentZero.restore).snapshot,
  );
  const stopRestore = recordValue(report.temporaryStopRestore);
  const stoppedSnapshot = recordValue(recordValue(stopRestore.stop).snapshot);
  const restoredSnapshot = recordValue(
    recordValue(stopRestore.restore).snapshot,
  );
  const idempotency = recordValue(report.idempotency);
  const firstAdmission = recordValue(recordValue(idempotency.first).admission);
  const retryAdmission = recordValue(recordValue(idempotency.retry).admission);
  const retrySerial = recordValue(recordValue(idempotency.retry).serial);
  const explicitRetry = recordValue(report.explicitRetry);
  const explicitRetryAdmission = recordValue(explicitRetry.admission);
  const explicitRetryFrame = recordValue(
    recordValue(explicitRetry.serial).protocolFrame,
  );
  const restart = recordValue(report.daemonRestart);
  const restartBefore = recordValue(restart.before);
  const restartAfter = recordValue(restart.after);
  const reconnect = recordValue(report.lowerControllerReconnect);
  const offlineAdmission = recordValue(reconnect.admission);
  const offlineSnapshot = recordValue(reconnect.offlineSnapshot);
  const reconnectedSnapshot = recordValue(reconnect.snapshot);
  const cleanupSnapshot = recordValue(recordValue(report.cleanup).snapshot);
  const b3Speed = (frame: unknown): number | null => {
    const match = /^55b3(0[0-4])$/i.exec(
      String(recordValue(frame).rawFrameHex ?? ""),
    );
    return match ? Number.parseInt(match[1], 16) : null;
  };
  const axisIndependent =
    axisSnapshots.length === 3 &&
    axisSnapshots.every(
      (snapshot) =>
        recordValue(snapshot.settings).baseVentSpeed === 3 &&
        recordValue(snapshot.desired).ventSpeed === 0 &&
        snapshot.convergence === "applied",
    );
  const persistentZeroProved =
    recordValue(persistentZeroSnapshot.settings).baseVentSpeed === 0 &&
    recordValue(persistentZeroSnapshot.desired).ventSpeed === 0 &&
    persistentZeroSnapshot.convergence === "applied";
  const stopRestoreProved =
    recordValue(stoppedSnapshot.settings).baseVentSpeed === 2 &&
    recordValue(stoppedSnapshot.desired).ventSpeed === 0 &&
    recordValue(restoredSnapshot.settings).baseVentSpeed === 2 &&
    recordValue(restoredSnapshot.desired).ventSpeed === 2 &&
    stoppedSnapshot.convergence === "applied" &&
    restoredSnapshot.convergence === "applied";
  const idempotencyProved =
    firstAdmission.outcome === "accepted" &&
    retryAdmission.outcome === "deduplicated" &&
    Number.isInteger(firstAdmission.acceptedRevision) &&
    retryAdmission.acceptedRevision === firstAdmission.acceptedRevision &&
    arrayValue(retrySerial.protocolFrames).length === 0;
  const explicitRetryProved =
    explicitRetryAdmission.outcome === "accepted" &&
    explicitRetryAdmission.acceptedRevision ===
      firstAdmission.acceptedRevision &&
    explicitRetryFrame.parsedOpcode === "B3" &&
    b3Speed(explicitRetryFrame) === 2;
  const restartProved =
    Number.isInteger(restartBefore.revision) &&
    restartAfter.revision === restartBefore.revision &&
    recordValue(restartAfter.settings).baseVentSpeed === 2 &&
    recordValue(restartAfter.desired).ventSpeed === 2 &&
    recordValue(restartAfter.confirmed).ventSpeed === 2 &&
    restartAfter.convergence === "applied" &&
    b3Speed(restart.frame) === 2;
  const reconnectProved =
    offlineAdmission.outcome === "accepted" &&
    offlineSnapshot.revision === offlineAdmission.acceptedRevision &&
    offlineSnapshot.convergence === "offline" &&
    recordValue(offlineSnapshot.settings).baseVentSpeed === 4 &&
    recordValue(offlineSnapshot.desired).ventSpeed === 4 &&
    reconnectedSnapshot.revision === offlineAdmission.acceptedRevision &&
    reconnectedSnapshot.convergence === "applied" &&
    recordValue(reconnectedSnapshot.confirmed).ventSpeed === 4 &&
    reconnect.disconnectedSessionId !== reconnect.reconnectedSessionId &&
    b3Speed(reconnect.frame) === 4;
  const daemon = maybeRecord(report.daemon);
  const environmentControl = recordValue(daemon?.environmentControl);
  const environmentControlHealth = recordValue(environmentControl.health);
  const cleanupProved =
    cleanupSnapshot.convergence === "applied" &&
    recordValue(cleanupSnapshot.settings).airConditionerEnabled === false &&
    recordValue(cleanupSnapshot.settings).targetTemperatureCelsius === 26 &&
    recordValue(cleanupSnapshot.settings).baseVentSpeed === 3 &&
    recordValue(cleanupSnapshot.desired).ventSpeed === 0;
  const environmentHealthProved =
    environmentControlHealth.component === "environment_control" &&
    environmentControlHealth.level === "ok" &&
    environmentControlHealth.code === "ENVIRONMENT_CONTROL_APPLIED";
  const replacementEvidence =
    typeof sessionReplacement.previousControlPlaneSessionId === "string" &&
    sessionReplacement.previousControlPlaneSessionId !== "" &&
    typeof replacementSessionId === "string" &&
    replacementSessionId !== "" &&
    replacementSessionId !== sessionReplacement.previousControlPlaneSessionId &&
    report.handoffSerialSessionId === replacementSessionId;
  if (
    hasRequiredActions !== true ||
    recordValue(report.boundaries)?.adminApi !== true ||
    recordValue(report.boundaries)?.mqtt !== true ||
    recordValue(report.boundaries)?.daemonIpc !== true ||
    recordValue(report.boundaries)?.lowerSerial !== true ||
    recordValue(report.boundaries)?.daemonRestart !== true ||
    recordValue(report.boundaries)?.lowerControllerReconnect !== true ||
    recordValue(daemon?.health)?.hardwareOnline !== true ||
    recordValue(daemon?.readiness)?.ready !== true ||
    axisIndependent !== true ||
    persistentZeroProved !== true ||
    stopRestoreProved !== true ||
    idempotencyProved !== true ||
    explicitRetryProved !== true ||
    restartProved !== true ||
    reconnectProved !== true ||
    cleanupProved !== true ||
    environmentHealthProved !== true ||
    replacementEvidence !== true ||
    commandRecords.every(validCommand) !== true
  ) {
    return failedTrack(
      "environmentControl",
      "environment control",
      reportPath,
      "environment control evidence is incomplete",
      {
        commands,
        boundaries: maybeRecord(report.boundaries),
        daemon,
        persistentZero,
        stopRestore,
        idempotency,
        restart,
        reconnect,
        sessionReplacement,
      },
    );
  }
  return passedTrack("environmentControl", "environment control", reportPath, {
    commandNos: commandRecords.map(
      (entry) => recordValue(entry.admin).commandNo,
    ),
    stateMachine: {
      persistentZero: true,
      temporaryStopRestore: true,
      idempotency: true,
      explicitRetry: true,
      daemonRestart: true,
      lowerControllerReconnect: true,
      replacementSessionId,
    },
  });
}

function canonicalResult(
  descriptor: JsonRecord,
  result: TrackResult,
  reportPath: string,
): TrackResult {
  return {
    ...result,
    key: String(descriptor.name),
    label: String(descriptor.name),
    reportPath,
  };
}

function validateVisionExperienceCapturedSource(
  set: JsonRecord,
  visionBaseUrl = "http://127.0.0.1:27892",
): CapturedSourceEvidence | null {
  const expectedVisionOrigin = normalizeVisionOrigin(visionBaseUrl);
  if (!expectedVisionOrigin) return null;
  const sources = arrayValue(set?.supportingEvidence).filter(
    (entry: unknown) => recordValue(entry).kind === "vision-v2-captured-source",
  );
  if (sources.length !== 1) return null;
  const source = validateCapturedSourceEvidence(sources[0]);
  if (!source || source.visionOrigin !== expectedVisionOrigin) return null;
  const assertions = arrayValue(set?.assertions);
  const bindings = assertions.filter(
    (assertion: unknown) =>
      recordValue(assertion).id === "captured-source-bound",
  );
  const binding = capturedSourceBinding(source);
  const assertion = maybeRecord(bindings[0]);
  if (
    bindings.length !== 1 ||
    assertion?.schemaVersion !== "vem-runtime-testbed-business-assertion/v1" ||
    assertion?.source !== "vision-v2-protocol" ||
    assertion?.status !== "passed" ||
    assertion?.reason !== null ||
    !hasSameCapturedEvidenceValue(assertion?.expected, binding) ||
    !hasSameCapturedEvidenceValue(assertion?.observed, binding)
  ) {
    return null;
  }
  return source;
}

const VISION_EXPERIENCE_TIMELINE_ASSERTIONS = [
  "countdown-rendered-sequence",
  "countdown-visible-duration",
  "countdown-protocol-dom-consistent",
  "captured-absent-outside-held",
  "capture-after-countdown",
  "preview-live-through-countdown",
  "captured-frame-held-during-generation",
];
const VISION_EXPERIENCE_GEOMETRY_ASSERTIONS = [
  "result-sleeves-retained",
  "result-uniform-placement",
  "result-automatic-scale",
  "garment-scale-renders-pixels",
];
const VISION_EXPERIENCE_ADJUSTMENT_ASSERTIONS = [
  "garment-scale-v2-adjustment-sequence",
];
const IMPLICIT_RECOMMENDATION_ASSERTIONS = [
  ["near.neutral-visible-within-500ms", "machine.runtime_trace+semantic_dom"],
  ["near.stable-ten-seconds", "semantic_dom+machine.runtime_trace"],
  ["near.catalog-detail-chinese-size", "semantic_dom"],
  ["near.departure-once", "machine.runtime_trace+semantic_dom"],
  ["far.neutral-visible-within-500ms", "machine.runtime_trace+semantic_dom"],
  ["far.stable-ten-seconds", "semantic_dom+machine.runtime_trace"],
  ["far.catalog-detail-chinese-size", "semantic_dom"],
  ["far.departure-once", "machine.runtime_trace+semantic_dom"],
  ["sessions.distinct", "machine.runtime_trace+fixture_restore"],
] as const;

function hasPassingAssertions(
  set: JsonRecord,
  ids: string[],
  source: string,
): boolean {
  const assertions = arrayValue(set?.assertions);
  return ids.every((id: string) => {
    const matches = assertions.filter(
      (assertion: unknown) => recordValue(assertion).id === id,
    );
    const match = maybeRecord(matches[0]);
    return (
      matches.length === 1 &&
      match?.schemaVersion === "vem-runtime-testbed-business-assertion/v1" &&
      match?.source === source &&
      match?.status === "passed" &&
      match?.reason === null
    );
  });
}

function hasPassingVisionExperienceTimelineAssertions(
  set: JsonRecord,
): boolean {
  return hasPassingAssertions(
    set,
    VISION_EXPERIENCE_TIMELINE_ASSERTIONS,
    "vision-experience-observation-timeline",
  );
}

function hasPassingVisionExperienceGeometryAssertions(
  set: JsonRecord,
): boolean {
  return hasPassingAssertions(
    set,
    VISION_EXPERIENCE_GEOMETRY_ASSERTIONS,
    "vision-result-png-pixels",
  );
}

function hasPassingVisionExperienceAdjustmentAssertions(
  set: JsonRecord,
): boolean {
  return hasPassingAssertions(
    set,
    VISION_EXPERIENCE_ADJUSTMENT_ASSERTIONS,
    "vision-v2-protocol",
  );
}

function hasPassingImplicitRecommendationAssertions(set: JsonRecord): boolean {
  const assertions = arrayValue(set.assertions);
  if (
    set.assertionCount !== assertions.length ||
    assertions.length !== IMPLICIT_RECOMMENDATION_ASSERTIONS.length
  ) {
    return false;
  }
  return IMPLICIT_RECOMMENDATION_ASSERTIONS.every(([id, source]) => {
    const matches = assertions.filter(
      (entry: unknown) => recordValue(entry).id === id,
    );
    const assertion = maybeRecord(matches[0]);
    return (
      matches.length === 1 &&
      assertion?.schemaVersion ===
        "vem-runtime-testbed-business-assertion/v1" &&
      assertion.source === source &&
      assertion.status === "passed" &&
      assertion.reason === null &&
      JSON.stringify(assertion.expected ?? null) ===
        JSON.stringify(assertion.observed ?? null)
    );
  });
}

function visionGeometryFixtureBlocker(set: JsonRecord): string | null {
  const evidence = arrayValue(set?.supportingEvidence).find(
    (entry: unknown) => {
      const record = recordValue(entry);
      return (
        record.kind === "vision-recorded-geometry-fixture" &&
        record.status === "blocked" &&
        typeof record.reason === "string" &&
        record.reason.length > 0
      );
    },
  );
  const evidenceRecord = maybeRecord(evidence);
  return typeof evidenceRecord?.reason === "string"
    ? evidenceRecord.reason
    : null;
}

export function validateBusinessCheckReport(
  descriptor: JsonRecord,
  report: JsonRecord | null | undefined,
  reportPath: string,
  context: JsonRecord = {},
): TrackResult {
  const descriptorName = String(descriptor?.name ?? "unknown");
  if (!descriptor?.runner) {
    return failedTrack(
      descriptorName,
      descriptorName,
      reportPath,
      String(descriptor?.blockedReason ?? "business runner is not implemented"),
    );
  }
  const validators: Record<
    string,
    (report: JsonRecord, reportPath: string) => TrackResult
  > = {
    commissioning: (value: JsonRecord, path: string): TrackResult => {
      const admission = recordValue(value.admission);
      return value?.schemaVersion ===
        "vem-runtime-commissioning-acceptance/v1" &&
        value?.ok === true &&
        admission?.status === "provisioned" &&
        typeof admission.machineCode === "string"
        ? passedTrack("commissioning", "commissioning", path, admission)
        : failedTrack(
            "commissioning",
            "commissioning",
            path,
            "commissioning admission evidence is incomplete",
          );
    },
    startup: validateStartupTrack,
    sale: validateFastTrack,
    scannerPayment: validateScannerTrack,
    pickupProtocol: validateDelayedAudioTrack,
    presenceAndAudio: validatePresenceAndAudioTrack,
    ipcRecovery: validateIpcRecoveryTrack,
    fulfillmentRecovery: validateFulfillmentFailureTrack,
    paymentRecovery: validatePaymentRecoveryTrack,
    paymentProvider: validatePaymentProviderTrack,
    stockMaintenance: validateStockMaintenanceTrack,
    hardwareLifecycle: validateHardwareLifecycleTrack,
    localOperations: validateLocalOperationsTrack,
    environmentControl: validateEnvironmentControlTrack,
  };
  if (descriptor.validator === "implicitRecommendation") {
    if (report?.schemaVersion === "vem-runtime-testbed-report/v2") {
      const sets = arrayValue(report.businessSets).filter(
        (entry: unknown) =>
          recordValue(entry).name === "implicitRecommendation",
      );
      const set = maybeRecord(sets[0]);
      const primaryFailure = recordValue(set?.primaryFailure);
      const passed =
        sets.length === 1 &&
        set?.status === "passed" &&
        set.primaryFailure === null &&
        hasPassingImplicitRecommendationAssertions(set);
      return canonicalResult(
        descriptor,
        passed
          ? passedTrack(
              "implicitRecommendation",
              "implicit recommendation",
              reportPath,
              { assertions: set?.assertionCount },
            )
          : failedTrack(
              descriptorName,
              descriptorName,
              reportPath,
              typeof primaryFailure.reason === "string"
                ? primaryFailure.reason
                : "implicit recommendation assertions are incomplete",
            ),
        reportPath,
      );
    }
    return canonicalResult(
      descriptor,
      failedTrack(
        descriptorName,
        descriptorName,
        reportPath,
        "implicitRecommendation requires a V2 business-set report",
      ),
      reportPath,
    );
  }
  if (descriptor.validator === "visionExperience") {
    if (report?.schemaVersion === "vem-runtime-testbed-report/v2") {
      const set = arrayValue(report.businessSets).find(
        (entry: unknown) => recordValue(entry).name === "visionExperience",
      ) as JsonRecord | undefined;
      if (!set) {
        return failedTrack(
          descriptorName,
          descriptorName,
          reportPath,
          "visionExperience v2 report has no business set",
        );
      }
      const capturedSource = validateVisionExperienceCapturedSource(
        set,
        typeof context.visionBaseUrl === "string"
          ? context.visionBaseUrl
          : "http://127.0.0.1:27892",
      );
      const geometryFixtureBlocker = visionGeometryFixtureBlocker(set);
      const setPrimaryFailure = recordValue(set.primaryFailure);
      const fixtureBlockerReason = geometryFixtureBlocker
        ? `visionExperience 几何录播夹具不可用：${geometryFixtureBlocker}`
        : set.status !== "passed"
          ? typeof setPrimaryFailure?.reason === "string"
            ? setPrimaryFailure.reason
            : "vision assertions failed"
          : "visionExperience timeline or captured source evidence is incomplete";
      return canonicalResult(
        descriptor,
        set.status === "passed" &&
          capturedSource &&
          hasPassingVisionExperienceTimelineAssertions(set) &&
          hasPassingVisionExperienceGeometryAssertions(set) &&
          hasPassingVisionExperienceAdjustmentAssertions(set)
          ? passedTrack("visionExperience", "vision experience", reportPath, {
              assertions: set.assertionCount,
              capturedFrameId: capturedSource.captured.frameId,
            })
          : failedTrack(
              descriptorName,
              descriptorName,
              reportPath,
              fixtureBlockerReason,
            ),
        reportPath,
      );
    }
    return canonicalResult(
      descriptor,
      failedTrack(
        descriptorName,
        descriptorName,
        reportPath,
        "visionExperience requires a V2 business-set report",
      ),
      reportPath,
    );
  }
  const validatorKey =
    typeof descriptor.validator === "string" ? descriptor.validator : "";
  const validator = validators[validatorKey];
  if (!validator) {
    return failedTrack(
      descriptorName,
      descriptorName,
      reportPath,
      `no validator is registered for ${descriptorName}`,
    );
  }
  return canonicalResult(
    descriptor,
    validator(report ?? {}, reportPath),
    reportPath,
  );
}

function buildRegistryWorkflowAggregate({
  mode,
  selectedDescriptors,
  executedTracks,
  evidenceManifestPath,
  evidenceManifest,
  evidenceManifestFile,
  evidenceValidationErrors,
  identity,
}: {
  mode: string;
  selectedDescriptors: JsonRecord[];
  executedTracks: JsonRecord[];
  evidenceManifestPath: string | null;
  evidenceManifest: JsonRecord | null;
  evidenceManifestFile: string | null;
  evidenceValidationErrors: unknown[];
  identity: JsonRecord | null;
}): JsonRecord {
  const expected = selectedDescriptors.map(
    (descriptor: JsonRecord) => descriptor.name,
  );
  const executed = executedTracks.map((entry: JsonRecord) => entry.key);
  const failures: Array<{
    set: string;
    reason: string;
    reportPath: string | null;
  }> = [];
  if (JSON.stringify(expected) !== JSON.stringify(executed)) {
    failures.push({
      set: "execution",
      reason: `business check execution order must be ${expected.join(" -> ")}; received ${executed.join(" -> ")}`,
      reportPath: null,
    });
  }
  const sets = Object.fromEntries(
    selectedDescriptors.map((descriptor: JsonRecord) => {
      const execution = executedTracks.find(
        (entry: JsonRecord) => entry.key === descriptor.name,
      );
      const executionFailed =
        execution?.businessStatus === "failed" ||
        execution?.status === "failed";
      const result = executionFailed
        ? failedTrack(
            String(descriptor.name),
            String(descriptor.name),
            typeof execution?.reportPath === "string"
              ? execution.reportPath
              : null,
            String(
              execution?.error ?? "business check execution lifecycle failed",
            ),
          )
        : ((execution?.validator as TrackResult | undefined) ??
          failedTrack(
            String(descriptor.name),
            String(descriptor.name),
            null,
            "registered business check was not executed",
          ));
      if (result.status !== "passed") {
        failures.push({
          set: String(descriptor.name),
          reason:
            result.reason ??
            String(execution?.error ?? "business check failed"),
          reportPath:
            result.reportPath ??
            (typeof execution?.reportPath === "string"
              ? execution.reportPath
              : null),
        });
      }
      return [String(descriptor.name), result] as const;
    }),
  ) as Record<string, TrackResult>;
  const evidenceFailures = [
    ...arrayValue(evidenceManifest?.failures),
    ...arrayValue(evidenceValidationErrors),
  ];
  return {
    schemaVersion: "vem-local-testbed-full-workflow/v4",
    mode,
    ok: failures.length === 0,
    execution: {
      selectedBusinessSets: expected,
      executedTracks,
    },
    businessSets: sets,
    failures,
    businessOutcome: { ok: failures.length === 0, failures },
    evidenceInventory: {
      reportPath: evidenceManifestPath,
      ok:
        evidenceManifest == null
          ? null
          : evidenceManifest.ok === true && evidenceFailures.length === 0,
      failures: evidenceFailures,
      manifestFile: evidenceManifestFile,
    },
    identity,
  };
}

export function buildFullWorkflowAggregate({
  mode,
  selectedDescriptors,
  evidenceManifestPath = null,
  evidenceManifest = null,
  evidenceManifestFile = null,
  evidenceValidationErrors = [],
  identity = null,
  executedTracks = [],
}: {
  mode?: unknown;
  selectedDescriptors?: unknown;
  evidenceManifestPath?: string | null;
  evidenceManifest?: JsonRecord | null;
  evidenceManifestFile?: string | null;
  evidenceValidationErrors?: unknown[];
  identity?: JsonRecord | null;
  executedTracks?: JsonRecord[];
} = {}): JsonRecord {
  const normalizedMode = requiredString(mode, "mode");
  if (!["fast", "full"].includes(normalizedMode)) {
    throw new Error("full workflow mode must be fast or full");
  }
  if (!Array.isArray(selectedDescriptors)) {
    throw new Error("selected business descriptors are required");
  }
  return buildRegistryWorkflowAggregate({
    mode: normalizedMode,
    selectedDescriptors: selectedDescriptors as JsonRecord[],
    executedTracks: executedTracks ?? [],
    evidenceManifestPath: evidenceManifestPath ?? null,
    evidenceManifest: evidenceManifest ?? null,
    evidenceManifestFile: evidenceManifestFile ?? null,
    evidenceValidationErrors: evidenceValidationErrors ?? [],
    identity: identity ?? null,
  });
}
