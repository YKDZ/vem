import { readFileSync } from "node:fs";

import { validateFullWorkflowEvidenceManifest } from "./full-workflow-evidence-manifest.mjs";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function jsonReport(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} report is unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function reportOrFailure(path, label) {
  try {
    return { value: jsonReport(path, label), error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function skippedTrack(key, label, reason) {
  return trackResult({ key, label, status: "skipped", reason });
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
  return acceptance.audio?.source === "windows_default_output" &&
    cueWindows.length === 5 &&
    cueWindows.every((entry) => entry?.kind === "passed")
    ? passedTrack("audio", "audio", reportPath, {
        cueCount: cueWindows.length,
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

function validateScannerTrack(report, reportPath) {
  if (
    report?.schemaVersion !== "vem-scanner-payment-code-guest-full/v1" ||
    report?.ok !== true
  ) {
    return failedTrack(
      "scanner",
      "scanner",
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
      ? passedTrack("scanner", "scanner", reportPath, {
          orderId,
          paymentId,
          orderNo,
          scannerEventId:
            platformAttempt.scannerEventId ??
            report.scannerAttempt?.scannerEventId ??
            null,
        })
      : failedTrack(
          "scanner",
          "scanner",
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
      "scanner",
      "scanner",
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
      "fulfillmentFailure",
      "fulfillment failure",
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
      "fulfillmentFailure",
      "fulfillment failure",
      reportPath,
      "post-payment fulfillment failure evidence is incomplete",
      {
        assertions: report.assertions ?? null,
        cleanup: report.cleanup ?? null,
        paymentCompletion: report.paymentCompletion ?? null,
      },
    );
  }
  return passedTrack("fulfillmentFailure", "fulfillment failure", reportPath, {
    orderStatus: report.assertions.orderStatus,
    commandId: report.assertions.commandId,
    inventoryDelta: report.assertions.inventoryDelta,
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
  const tryOnUnavailable =
    report.degradations?.tryOnUnavailableWhileVisionOnline ?? {};
  const protocol = report.health?.vision?.protocolSummary ?? null;
  const tryOnSummary = report.ui?.tryOnSummary ?? null;
  const tryOnFailure = report.ui?.tryOnFailure ?? null;
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
    tryOnFailure &&
    tryOnUnavailable.experienceCapabilityDegraded === true &&
    tryOnUnavailable.saleStartStillAvailable === true &&
    tryOnUnavailable.visionOnline === true
      ? passedTrack("tryOn", "try-on", reportPath, {
          experienceCapabilityDegraded: true,
          visionOnline: true,
        })
      : failedTrack(
          "tryOn",
          "try-on",
          reportPath,
          "try-on degradation evidence is incomplete",
          {
            tryOnSummary,
            tryOnFailure,
            tryOnUnavailable,
          },
        );
  return { vision, tryOn };
}

function executionFailure(track, executedTracks) {
  const entry = executedTracks.find((candidate) => candidate?.key === track);
  if (!entry) return `required child ${track} was not executed`;
  if (entry.exitCode !== 0)
    return `child ${track} exited ${entry.exitCode ?? "without an exit code"}`;
  if (entry.reportOk !== true)
    return `child ${track} did not emit a valid passing report`;
  return null;
}

function failedForUnreadable(key, label, path, loaded) {
  return loaded.error ? failedTrack(key, label, path, loaded.error) : null;
}

export function buildFullWorkflowAggregate({
  mode,
  fastReportPath,
  ipcRecoveryReportPath = null,
  fulfillmentFailureReportPath = null,
  scannerReportPath = null,
  delayedPickupReportPath = null,
  visionTryOnReportPath = null,
  evidenceManifestPath = null,
  identity = null,
  executedTracks = [],
} = {}) {
  const normalizedMode = requiredString(mode, "mode");
  if (!["fast", "full"].includes(normalizedMode)) {
    throw new Error("full workflow mode must be fast or full");
  }
  const loadedFast = reportOrFailure(fastReportPath, "fast route");
  const fast =
    failedForUnreadable(
      "standardSale",
      "standard sale",
      fastReportPath,
      loadedFast,
    ) ?? validateFastTrack(loadedFast.value, fastReportPath);
  let audio = skippedTrack("audio", "audio", "full mode only");
  let ipcRecovery = skippedTrack(
    "ipcRecovery",
    "IPC recovery",
    "full mode only",
  );
  let fulfillmentFailure = skippedTrack(
    "fulfillmentFailure",
    "fulfillment failure",
    "full mode only",
  );
  let scanner = skippedTrack("scanner", "scanner", "full mode only");
  let vision = skippedTrack("vision", "Vision", "full mode only");
  let tryOn = skippedTrack("tryOn", "try-on", "full mode only");
  let error = skippedTrack("error", "error", "full mode only");
  let evidence = skippedTrack(
    "evidence",
    "evidence manifest",
    "full mode only",
  );
  const requiredChildren =
    normalizedMode === "full"
      ? [
          "fast",
          "delayedPickup",
          "scanner",
          "ipcRecovery",
          "fulfillmentFailure",
          "visionTryOn",
        ]
      : ["fast"];
  const executionFailures = requiredChildren
    .map((track) => executionFailure(track, executedTracks))
    .filter(Boolean);
  if (
    JSON.stringify(executedTracks.map((track) => track?.key)) !==
    JSON.stringify(requiredChildren)
  ) {
    executionFailures.push(
      `child execution order must be ${requiredChildren.join(" -> ")}; received ${executedTracks.map((track) => track?.key).join(" -> ")}`,
    );
  }
  if (normalizedMode === "full") {
    const evidenceManifest = reportOrFailure(
      evidenceManifestPath,
      "full workflow evidence manifest",
    );
    const evidenceFailures = evidenceManifest.error
      ? [evidenceManifest.error]
      : validateFullWorkflowEvidenceManifest(evidenceManifest.value);
    evidence =
      evidenceFailures.length === 0
        ? passedTrack("evidence", "evidence manifest", evidenceManifestPath, {
            totals: evidenceManifest.value.totals,
          })
        : failedTrack(
            "evidence",
            "evidence manifest",
            evidenceManifestPath,
            "bounded evidence manifest is incomplete",
            { failures: evidenceFailures },
          );
    const ipcRecoveryLoaded = reportOrFailure(
      ipcRecoveryReportPath,
      "installed IPC recovery",
    );
    const fulfillmentFailureLoaded = reportOrFailure(
      fulfillmentFailureReportPath,
      "serial fulfillment failure",
    );
    const delayed = reportOrFailure(delayedPickupReportPath, "delayed pickup");
    const scanned = reportOrFailure(scannerReportPath, "scanner payment-code");
    const visualLoaded = reportOrFailure(
      visionTryOnReportPath,
      "vision try-on",
    );
    ipcRecovery =
      failedForUnreadable(
        "ipcRecovery",
        "IPC recovery",
        ipcRecoveryReportPath,
        ipcRecoveryLoaded,
      ) ??
      validateIpcRecoveryTrack(ipcRecoveryLoaded.value, ipcRecoveryReportPath);
    fulfillmentFailure =
      failedForUnreadable(
        "fulfillmentFailure",
        "fulfillment failure",
        fulfillmentFailureReportPath,
        fulfillmentFailureLoaded,
      ) ??
      validateFulfillmentFailureTrack(
        fulfillmentFailureLoaded.value,
        fulfillmentFailureReportPath,
      );
    audio =
      failedForUnreadable("audio", "audio", delayedPickupReportPath, delayed) ??
      validateDelayedAudioTrack(delayed.value, delayedPickupReportPath);
    scanner =
      failedForUnreadable("scanner", "scanner", scannerReportPath, scanned) ??
      validateScannerTrack(scanned.value, scannerReportPath);
    const visualResult = failedForUnreadable(
      "vision",
      "Vision",
      visionTryOnReportPath,
      visualLoaded,
    );
    const visualTracks = visualResult
      ? {
          vision: visualResult,
          tryOn: failedTrack(
            "tryOn",
            "try-on",
            visionTryOnReportPath,
            visualResult.reason,
          ),
        }
      : validateVisionTrack(visualLoaded.value, visionTryOnReportPath);
    vision = visualTracks.vision;
    tryOn = visualTracks.tryOn;
    if (
      fast.status === "passed" &&
      ipcRecovery.status === "passed" &&
      fulfillmentFailure.status === "passed" &&
      scanner.status === "passed" &&
      evidence.status === "passed"
    ) {
      error = passedTrack("error", "error", fastReportPath, {
        scenarios: {
          visionRepeatedAction: fast.reportPath,
          scannerRecovery: scanner.reportPath,
          ipcRecovery: ipcRecovery.reportPath,
          serialE6: fulfillmentFailure.reportPath,
        },
      });
    } else {
      error = failedTrack(
        "error",
        "error",
        fastReportPath,
        "installed error-recovery evidence is incomplete",
        {
          standardSale: fast.status,
          ipcRecovery: ipcRecovery.status,
          fulfillmentFailure: fulfillmentFailure.status,
          scanner: scanner.status,
          evidence: evidence.status,
        },
      );
    }
  }
  if (executionFailures.length > 0) {
    for (const failure of executionFailures) {
      if (failure.includes("fast"))
        ((fast.status = "failed"), (fast.reason = failure));
      else if (failure.includes("ipcRecovery"))
        ((ipcRecovery.status = "failed"), (ipcRecovery.reason = failure));
      else if (failure.includes("fulfillmentFailure"))
        ((fulfillmentFailure.status = "failed"),
          (fulfillmentFailure.reason = failure));
      else if (failure.includes("delayedPickup"))
        ((audio.status = "failed"), (audio.reason = failure));
      else if (failure.includes("scanner"))
        ((scanner.status = "failed"), (scanner.reason = failure));
      else if (failure.includes("visionTryOn"))
        ((vision.status = "failed"), (vision.reason = failure));
    }
    error = failedTrack(
      "error",
      "error",
      fastReportPath,
      "full workflow child execution did not complete",
      { executionFailures },
    );
  }
  const tracks = {
    standardSale: fast,
    ipcRecovery,
    fulfillmentFailure,
    audio,
    scanner,
    vision,
    tryOn,
    evidence,
    error,
  };
  const failures = Object.values(tracks)
    .filter((track) => track.status === "failed")
    .map((track) => ({
      track: track.key,
      label: track.label,
      reason: track.reason,
      reportPath: track.reportPath,
    }));
  return {
    schemaVersion: "vem-local-testbed-full-workflow/v3",
    mode: normalizedMode,
    ok: failures.length === 0,
    execution: {
      checkoutBuildDeployCount: 1,
      rebuildBetweenTracks: false,
      resetBetweenTracks: false,
      validationOrder: [
        "standardSale",
        "audio",
        "scanner",
        "ipcRecovery",
        "fulfillmentFailure",
        "vision",
        "tryOn",
        "evidence",
        "error",
      ],
      executedTracks,
    },
    tracks,
    failures,
    identity,
  };
}
