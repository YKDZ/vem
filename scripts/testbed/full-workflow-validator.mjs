import { validatePresenceAndAudioGuestReport } from "./presence-and-audio-guest-full.mjs";
import { validatePaymentRecoveryEvidence } from "./payment-recovery-guest-full.mjs";
import { validateStockMaintenanceReport } from "./stock-maintenance-guest-full.mjs";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function trackResult({
  key,
  label,
  status,
  reportPath = null,
  details = null,
  reason = null,
}) {
  return {
    key,
    label,
    status,
    reportPath,
    reason,
    details,
  };
}

function failedTrack(key, label, reportPath, reason, details = null) {
  return trackResult({
    key,
    label,
    status: "failed",
    reportPath,
    reason,
    details,
  });
}

function passedTrack(key, label, reportPath, details = null) {
  return trackResult({
    key,
    label,
    status: "passed",
    reportPath,
    details,
  });
}

function validateFastTrack(report, reportPath) {
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
  const summary = report.summary ?? {};
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

function validateDelayedAudioTrack(report, reportPath) {
  const acceptance = report?.delayedPickupNativeAudio ?? null;
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
  const cueWindows = Array.isArray(acceptance.audio?.cueWindows)
    ? acceptance.audio.cueWindows
    : [];
  const cueStartLatencyMs = acceptance.controller?.cueStartLatencyMs ?? {};
  const requiredCues = [
    "pickup_started",
    "ordinary_warning",
    "urgent_warning",
    "dispense_succeeded",
  ];
  const capture = acceptance.audio?.capture ?? {};
  return acceptance.audio?.source === "windows_default_output" &&
    cueWindows.length > 0 &&
    cueWindows.every((entry) => entry?.kind === "passed") &&
    requiredCues.every(
      (cue) =>
        Number.isFinite(cueStartLatencyMs[cue]) &&
        cueStartLatencyMs[cue] >= 0 &&
        cueStartLatencyMs[cue] <= 2_000,
    ) &&
    capture.nonSilentFrameCount > 0 &&
    capture.peakAbsoluteSample > 0
    ? passedTrack("audio", "audio", reportPath, {
        cueCount: requiredCues.length,
        source: acceptance.audio.source,
      })
    : failedTrack(
        "audio",
        "audio",
        reportPath,
        "audio cue windows are incomplete",
        acceptance.audio ?? null,
      );
}

function validatePresenceAndAudioTrack(report, reportPath) {
  try {
    const summary = validatePresenceAndAudioGuestReport(report);
    return passedTrack("presenceAndAudio", "presence and audio", reportPath, {
      welcomeTransitions: summary.welcomeTransitions,
      categoryTransitions: summary.categoryTransitions.map(
        (entry) => entry.key,
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
      report?.presenceAndAudio ?? report ?? null,
    );
  }
}

function validateScannerTrack(report, reportPath) {
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
  const malformed = report.invalidScanEvidence?.malformed ?? {};
  const timeout = report.invalidScanEvidence?.timeout ?? {};
  const finalResult = report.final?.result ?? {};
  const platformAttempt = report.platformAssertions?.attempt ?? {};
  const orderId = report.renderedSale?.orderId ?? finalResult.orderId;
  const paymentId = report.renderedSale?.paymentId ?? finalResult.paymentId;
  const orderNo = report.renderedSale?.orderNo ?? finalResult.orderNo;
  const scanner =
    orderId &&
    paymentId &&
    orderNo &&
    report.scannerAttempt?.source === "serial_text" &&
    platformAttempt.status === "succeeded" &&
    report.platformAssertions?.movement &&
    finalResult.kind === "success"
      ? passedTrack("scannerPayment", "scanner payment", reportPath, {
          orderId,
          paymentId,
          orderNo,
          scannerEventId:
            platformAttempt.scannerEventId ??
            report.scannerAttempt?.scannerEventId ??
            null,
        })
      : failedTrack(
          "scannerPayment",
          "scanner payment",
          reportPath,
          "scanner payment-code success path is incomplete",
          {
            renderedSale: report.renderedSale ?? null,
            scannerAttempt: report.scannerAttempt ?? null,
            platformAssertions: report.platformAssertions ?? null,
            final: report.final ?? null,
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

function validateIpcRecoveryTrack(report, reportPath) {
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
  if (
    report.cleanup?.ok !== true ||
    report.ipcRecovery?.evidence?.status !== "passed" ||
    report.ipcRecovery?.assertions?.overlayObserved !== true ||
    report.ipcRecovery?.assertions?.retainedOrderCredential !==
      report.renderedSale?.orderNo ||
    report.ipcRecovery?.assertions?.resumedOrderCredential !==
      report.renderedSale?.orderNo ||
    report.ipcRecovery?.assertions?.daemonTransportPhase !== "recovered" ||
    report.result?.kind !== "success" ||
    report.liveSale?.vendingCommandId == null
  ) {
    return failedTrack(
      "ipcRecovery",
      "IPC recovery",
      reportPath,
      "installed IPC recovery evidence is incomplete",
      {
        renderedSale: report.renderedSale ?? null,
        assertions: report.ipcRecovery?.assertions ?? null,
        evidence: report.ipcRecovery?.evidence ?? null,
        result: report.result ?? null,
        cleanup: report.cleanup ?? null,
      },
    );
  }
  return passedTrack("ipcRecovery", "IPC recovery", reportPath, {
    orderNo: report.renderedSale.orderNo,
    vendingCommandId: report.liveSale.vendingCommandId,
  });
}

function validateFulfillmentFailureTrack(report, reportPath) {
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
  if (
    report.cleanup?.error ||
    report.assertions?.inventoryDelta !== 0 ||
    !["refund_pending", "refunded", "manual_handling"].includes(
      report.assertions?.orderStatus,
    ) ||
    report.assertions?.commandId == null ||
    report.paymentCompletion == null
  ) {
    return failedTrack(
      "fulfillmentRecovery",
      "fulfillment recovery",
      reportPath,
      "post-payment fulfillment failure evidence is incomplete",
      {
        assertions: report.assertions ?? null,
        cleanup: report.cleanup ?? null,
        paymentCompletion: report.paymentCompletion ?? null,
      },
    );
  }
  return passedTrack(
    "fulfillmentRecovery",
    "fulfillment recovery",
    reportPath,
    {
      orderStatus: report.assertions.orderStatus,
      commandId: report.assertions.commandId,
      inventoryDelta: report.assertions.inventoryDelta,
    },
  );
}

function validatePaymentRecoveryTrack(report, reportPath) {
  try {
    const summary = validatePaymentRecoveryEvidence(report);
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

function validatePaymentProviderTrack(report, reportPath) {
  if (
    report?.schemaVersion !== "vem-payment-provider-guest-full/v1" ||
    report?.ok !== true ||
    report?.environment?.environment !== "sandbox" ||
    report?.environment?.readiness !== "ready" ||
    report?.authoritative?.ok !== true
  ) {
    return failedTrack(
      "paymentProvider",
      "payment provider",
      reportPath,
      "payment provider boundary did not finish successfully",
      report ?? null,
    );
  }
  const attempts = report.authoritative.attempts;
  const qr = attempts?.find((attempt) => attempt?.channel === "qr_code:alipay");
  const code = attempts?.find(
    (attempt) => attempt?.channel === "payment_code:alipay",
  );
  const terminalClean = (attempt) =>
    attempt?.terminal?.reservedInventory === false &&
    ["failed", "canceled", "expired"].includes(
      attempt?.terminal?.paymentStatus,
    );
  const qrValid =
    qr?.order?.providerCode === "alipay" &&
    qr?.machine?.boundary === "installed_machine_ui_cdp" &&
    qr?.machine?.paymentMethod === "qr_code" &&
    qr?.machine?.providerCode === "alipay" &&
    qr?.machine?.surface?.orderId === qr?.order?.orderId &&
    qr?.machine?.surface?.paymentId === qr?.order?.paymentId &&
    qr?.machine?.surface?.orderNo === qr?.order?.orderNo &&
    String(qr?.credential?.paymentUrlSha256 ?? "").startsWith("sha256:") &&
    typeof qr?.query?.reconciliationAttemptId === "string" &&
    qr.query.reconciliationAttemptId.length > 0 &&
    qr?.query?.providerCode === "alipay" &&
    qr?.query?.status === "provider_trade_not_exist" &&
    qr?.query?.providerPaymentStatus === "pending" &&
    qr?.closure?.action === "close_or_reverse_uncertain_payment" &&
    qr?.closure?.handled === true &&
    typeof qr?.closure?.providerConfigId === "string" &&
    qr.closure.providerConfigId ===
      report?.provider?.identity?.providerConfigId &&
    ["canceled", "expired"].includes(qr?.terminal?.paymentStatus) &&
    terminalClean(qr);
  const codeValid =
    code?.order?.providerCode === "alipay" &&
    code?.machine?.boundary === "installed_machine_ui_cdp" &&
    code?.machine?.paymentMethod === "payment_code" &&
    code?.machine?.providerCode === "alipay" &&
    code?.machine?.surface?.orderId === code?.order?.orderId &&
    code?.machine?.surface?.paymentId === code?.order?.paymentId &&
    code?.machine?.surface?.orderNo === code?.order?.orderNo &&
    String(code?.machine?.scannerPrompt ?? "").includes("请出示付款码") &&
    code?.submission?.providerCode === "alipay" &&
    typeof code?.submission?.attemptId === "string" &&
    code.submission.attemptId.length > 0 &&
    code?.submission?.status === "failed" &&
    typeof code?.submission?.failureCode === "string" &&
    code.submission.failureCode.length > 0 &&
    typeof code?.submission?.providerStatus === "string" &&
    code.submission.providerStatus.length > 0 &&
    code?.cleanup?.action === "customer_cancel_order" &&
    code?.cleanup?.serialSession?.action === "abort" &&
    code?.cleanup?.serialSession?.aborted === true &&
    typeof code?.cleanup?.providerConfigId === "string" &&
    code.cleanup.providerConfigId ===
      report?.provider?.identity?.providerConfigId &&
    terminalClean(code);
  const providerIdentity = report?.provider?.identity;
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
    report?.provider?.hostPreparation?.source === "host_installation_fixture" &&
    report?.provider?.hostPreparation?.preflight === "configured";
  const uniqueOrders = new Set(
    attempts.map((attempt) => attempt?.order?.orderId).filter(Boolean),
  );
  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics
    : [];
  if (
    attempts?.length !== 2 ||
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
    qrOrderId: qr.order.orderId,
    paymentCodeOrderId: code.order.orderId,
    diagnosticAttempts: diagnostics.length,
  });
}

function stockIs(value, quantity, saleable) {
  return (
    value?.physicalStock === quantity &&
    value?.saleableStock === saleable &&
    typeof value?.slotSalesState === "string"
  );
}

function validateStockMaintenanceTrack(report, reportPath) {
  try {
    const summary = validateStockMaintenanceReport(report);
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

function validateLocalOperationsTrack(report, reportPath) {
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
  if (
    report.boundaries?.daemon !== true ||
    report.boundaries?.hardwareSelfCheck !== true ||
    report.boundaries?.serial !== true ||
    report.planogram?.canonical !== true ||
    !report.planogram?.planogramVersion ||
    !report.planogram?.slotDisplayLabel ||
    !["completed", "failed", "result_unknown"].includes(
      report.manualDispense?.outcome,
    ) ||
    report.manualDispense?.slotDisplayLabel !==
      report.planogram.slotDisplayLabel
  ) {
    return failedTrack(
      "localOperations",
      "local operations",
      reportPath,
      "local operations evidence is incomplete",
      {
        boundaries: report.boundaries ?? null,
        planogram: report.planogram ?? null,
        manualDispense: report.manualDispense ?? null,
      },
    );
  }
  return passedTrack("localOperations", "local operations", reportPath, {
    slotDisplayLabel: report.planogram.slotDisplayLabel,
    planogramVersion: report.planogram.planogramVersion,
    manualOutcome: report.manualDispense.outcome,
  });
}

function validateHardwareLifecycleTrack(report, reportPath) {
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
  const discovery = report.discovery ?? {};
  const readiness = report.readiness ?? {};
  const lifecycle = Array.isArray(report.lifecycle) ? report.lifecycle : [];
  const byRole = new Map(lifecycle.map((entry) => [entry?.role, entry]));
  const lower = byRole.get("lower_controller");
  const scanner = byRole.get("scanner");
  const roles = Array.isArray(discovery.roles) ? discovery.roles : [];
  const qemuMappings = Array.isArray(discovery.qemuUsbSerialMappings)
    ? discovery.qemuUsbSerialMappings
    : [];
  const stableReadiness =
    readiness.before?.canStartSale === true &&
    readiness.after?.canStartSale === true &&
    Number.isInteger(readiness.before?.revision) &&
    Number.isInteger(readiness.after?.revision) &&
    readiness.after.revision >= readiness.before.revision;
  const validLifecycle = [lower, scanner].every(
    (entry) =>
      entry?.disconnect?.boundary?.adapter === "file_backed_windows_pnp" &&
      entry.disconnect.boundary.operation === "disconnect" &&
      entry.disconnect.boundary.identityKey === entry.identityKey &&
      entry.disconnect?.daemon?.ready === false &&
      entry.disconnect?.daemon?.currentPort == null &&
      entry?.reconnect?.boundary?.adapter === "file_backed_windows_pnp" &&
      entry.reconnect.boundary.operation === "reconnect" &&
      entry.reconnect.boundary.identityKey === entry.identityKey &&
      entry.reconnect?.daemon?.ready === true &&
      typeof entry.reconnect?.daemon?.currentPort === "string" &&
      entry.reconnect.daemon.identityKey === entry.identityKey,
  );
  const lowerCapabilityValid =
    lower?.disconnect?.saleStartCapability?.canStartSale === false &&
    lower?.reconnect?.saleStartCapability?.canStartSale === true;
  const scannerPaymentOptions = (capability) =>
    (capability?.paymentOptions?.options ?? []).filter(
      (option) => option?.method === "payment_code",
    );
  const scannerCapabilityValid =
    scannerPaymentOptions(scanner?.disconnect?.saleStartCapability).length >
      0 &&
    scannerPaymentOptions(scanner.disconnect.saleStartCapability).every(
      (option) => option?.ready === false,
    ) &&
    scannerPaymentOptions(scanner?.reconnect?.saleStartCapability).some(
      (option) => option?.ready === true,
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
    roles: roles.map((role) => role.role),
    readinessRevision: readiness.after.revision,
    lifecycleRoles: lifecycle.map((entry) => entry.role),
  });
}

function validateEnvironmentControlTrack(report, reportPath) {
  if (
    report?.schemaVersion !== "vem-environment-control-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "environmentControl",
      "environment control",
      reportPath,
      "environment control track did not finish successfully",
    );
  }
  const commands = Array.isArray(report.commands) ? report.commands : [];
  const byAction = new Map(commands.map((entry) => [entry?.action, entry]));
  const requiredActions = [
    "airConditionerOnTrue",
    "airConditionerOnFalse",
    "ventSpeed",
  ];
  const optionalTemperature = byAction.get("targetTemperatureCelsius") ?? null;
  const hasRequiredActions = requiredActions.every((action) => {
    const entry = byAction.get(action);
    return (
      entry?.admin?.commandNo &&
      entry?.admin?.status === "sent" &&
      entry?.result?.status === "succeeded" &&
      entry?.result?.resultJson?.success === true &&
      entry?.mqtt?.commandObserved === true &&
      entry?.mqtt?.resultObserved === true &&
      entry?.serial?.lowerBoundaryObserved === true
    );
  });
  const hasTemperature =
    optionalTemperature === null ||
    (optionalTemperature.result?.status === "succeeded" &&
      optionalTemperature.result?.resultJson?.success === true &&
      optionalTemperature.serial?.lowerBoundaryObserved === true);
  const overlap = report.overlapRejection ?? {};
  if (
    hasRequiredActions !== true ||
    hasTemperature !== true ||
    overlap.rejected !== true ||
    overlap.httpStatus !== 409 ||
    overlap.error !== "ENVIRONMENT_COMMAND_IN_PROGRESS" ||
    report.boundaries?.adminApi !== true ||
    report.boundaries?.mqtt !== true ||
    report.boundaries?.daemonIpc !== true ||
    report.boundaries?.lowerSerial !== true
  ) {
    return failedTrack(
      "environmentControl",
      "environment control",
      reportPath,
      "environment control evidence is incomplete",
      { commands, overlap, boundaries: report.boundaries ?? null },
    );
  }
  return passedTrack("environmentControl", "environment control", reportPath, {
    commandNos: commands.map((entry) => entry.admin.commandNo),
    overlapError: overlap.error,
    temperatureProved: optionalTemperature !== null,
  });
}

function validateVisionTrack(report, reportPath) {
  if (
    report?.schemaVersion !== "vem-vision-try-on-acceptance/v1" ||
    report?.ok !== true
  ) {
    return {
      vision: failedTrack(
        "vision",
        "Vision",
        reportPath,
        "vision acceptance did not finish successfully",
      ),
      tryOn: failedTrack(
        "tryOn",
        "try-on",
        reportPath,
        "try-on acceptance did not finish successfully",
      ),
    };
  }
  const visionDown = report.degradations?.visionDown ?? {};
  const protocol = report.health?.vision?.protocolSummary ?? null;
  const tryOnSummary = report.ui?.tryOnSummary ?? null;
  const vision =
    protocol &&
    visionDown.experienceCapabilityDegraded === true &&
    visionDown.saleStartStillAvailable === true
      ? passedTrack("vision", "Vision", reportPath, {
          experienceCapabilityDegraded: true,
          saleStartStillAvailable: true,
        })
      : failedTrack(
          "vision",
          "Vision",
          reportPath,
          "vision degradation evidence is incomplete",
          { protocol, visionDown },
        );
  const tryOn =
    tryOnSummary &&
    tryOnSummary.width > 0 &&
    tryOnSummary.height > 0 &&
    tryOnSummary.silhouetteHttpStatus === 200 &&
    report.ui?.tryOnAttempts?.some((attempt) => attempt?.result === "passed") &&
    visionDown.saleStartStillAvailable === true
      ? passedTrack("tryOn", "try-on", reportPath, {
          previewWidth: tryOnSummary.width,
          previewHeight: tryOnSummary.height,
          silhouetteHttpStatus: tryOnSummary.silhouetteHttpStatus,
        })
      : failedTrack(
          "tryOn",
          "try-on",
          reportPath,
          "try-on degradation evidence is incomplete",
          {
            tryOnSummary,
            tryOnAttempts: report.ui?.tryOnAttempts ?? null,
            visionDown,
          },
        );
  return { vision, tryOn };
}

function canonicalResult(descriptor, result, reportPath) {
  return {
    ...result,
    key: descriptor.name,
    label: descriptor.name,
    reportPath,
  };
}

export function validateBusinessCheckReport(descriptor, report, reportPath) {
  if (!descriptor?.runner) {
    return failedTrack(
      descriptor?.name ?? "unknown",
      descriptor?.name ?? "unknown",
      reportPath,
      descriptor?.blockedReason ?? "business runner is not implemented",
    );
  }
  const validators = {
    commissioning: (value, path) =>
      value?.schemaVersion === "vem-runtime-commissioning-acceptance/v1" &&
      value?.ok === true &&
      value?.admission?.status === "provisioned" &&
      typeof value.admission.machineCode === "string"
        ? passedTrack("commissioning", "commissioning", path, value.admission)
        : failedTrack(
            "commissioning",
            "commissioning",
            path,
            "commissioning admission evidence is incomplete",
          ),
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
  if (descriptor.validator === "visionExperience") {
    const result = validateVisionTrack(report, reportPath);
    const failed = Object.values(result).find(
      (entry) => entry.status !== "passed",
    );
    return canonicalResult(
      descriptor,
      failed ??
        passedTrack("visionExperience", "vision experience", reportPath, {
          vision: result.vision.details,
          tryOn: result.tryOn.details,
        }),
      reportPath,
    );
  }
  const validator = validators[descriptor.validator];
  if (!validator) {
    return failedTrack(
      descriptor.name,
      descriptor.name,
      reportPath,
      `no validator is registered for ${descriptor.name}`,
    );
  }
  return canonicalResult(descriptor, validator(report, reportPath), reportPath);
}

function buildRegistryWorkflowAggregate({
  mode,
  selectedDescriptors,
  executedTracks,
  evidenceManifestPath,
  identity,
}) {
  const expected = selectedDescriptors.map((descriptor) => descriptor.name);
  const executed = executedTracks.map((entry) => entry.key);
  const failures = [];
  if (JSON.stringify(expected) !== JSON.stringify(executed)) {
    failures.push({
      set: "execution",
      reason: `business check execution order must be ${expected.join(" -> ")}; received ${executed.join(" -> ")}`,
      reportPath: null,
    });
  }
  const sets = Object.fromEntries(
    selectedDescriptors.map((descriptor) => {
      const execution = executedTracks.find(
        (entry) => entry.key === descriptor.name,
      );
      const result =
        execution?.validator ??
        failedTrack(
          descriptor.name,
          descriptor.name,
          null,
          "registered business check was not executed",
        );
      if (result.status !== "passed") {
        failures.push({
          set: descriptor.name,
          reason: result.reason ?? execution?.error ?? "business check failed",
          reportPath: result.reportPath ?? execution?.reportPath ?? null,
        });
      }
      return [descriptor.name, result];
    }),
  );
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
    evidenceInventory: { reportPath: evidenceManifestPath },
    identity,
  };
}

export function buildFullWorkflowAggregate({
  mode,
  selectedDescriptors,
  evidenceManifestPath = null,
  identity = null,
  executedTracks = [],
} = {}) {
  const normalizedMode = requiredString(mode, "mode");
  if (!["fast", "full"].includes(normalizedMode)) {
    throw new Error("full workflow mode must be fast or full");
  }
  if (!Array.isArray(selectedDescriptors)) {
    throw new Error("selected business descriptors are required");
  }
  return buildRegistryWorkflowAggregate({
    mode: normalizedMode,
    selectedDescriptors,
    executedTracks,
    evidenceManifestPath,
    identity,
  });
}
