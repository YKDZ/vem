import { readFileSync } from "node:fs";

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

function trackResult({ key, label, status, reportPath = null, details = null, reason = null }) {
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
    JSON.stringify(summary.protocol) !== JSON.stringify(["VEND", "F0", "F1", "F2"]) ||
    summary.daemonStockDeltaAfterF2 !== -1 ||
    summary.platformStockDeltaAfterF2 !== -1
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
    return {
      scanner: failedTrack(
        "scanner",
        "scanner",
        reportPath,
        "scanner payment-code acceptance did not finish successfully",
      ),
      errorEvidence: failedTrack(
        "error",
        "error",
        reportPath,
        "scanner malformed/timeout evidence is unavailable",
      ),
    };
  }
  const malformed = report.invalidScanEvidence?.malformed ?? {};
  const timeout = report.invalidScanEvidence?.timeout ?? {};
  const finalResult = report.final?.result ?? {};
  const scanner =
    report.renderedSale?.orderId &&
    report.renderedSale?.paymentId &&
    report.renderedSale?.orderNo &&
    report.scannerAttempt?.status === "succeeded" &&
    report.scannerAttempt?.source === "serial_text" &&
    report.platformAssertions?.attempt?.status === "succeeded" &&
    report.platformAssertions?.movement &&
    finalResult.kind === "success"
      ? passedTrack("scanner", "scanner", reportPath, {
          orderId: report.renderedSale.orderId,
          paymentId: report.renderedSale.paymentId,
          orderNo: report.renderedSale.orderNo,
          scannerEventId: report.scannerAttempt?.scannerEventId ?? null,
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
  const errorEvidence =
    malformed.attemptCount === 0 &&
    malformed.paymentDelta === 0 &&
    timeout.attemptCount === 0 &&
    timeout.paymentDelta === 0
      ? passedTrack("error", "error", reportPath, {
          malformedAttemptCount: 0,
          malformedPaymentDelta: 0,
          timeoutAttemptCount: 0,
          timeoutPaymentDelta: 0,
        })
      : failedTrack(
          "error",
          "error",
          reportPath,
          "scanner malformed/timeout evidence is incomplete",
          { malformed, timeout },
        );
  return { scanner, errorEvidence };
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
      error: failedTrack(
        "error",
        "error",
        reportPath,
        "degradation evidence from vision acceptance is unavailable",
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
  const error =
    vision.status === "passed" && tryOn.status === "passed"
      ? passedTrack("error", "error", reportPath, {
          source: "vision degradation and try-on degradation",
        })
      : failedTrack(
          "error",
          "error",
          reportPath,
          "vision/try-on degradation evidence is incomplete",
        );
  return { vision, tryOn, error };
}

export function buildFullWorkflowAggregate({
  mode,
  fastReportPath,
  scannerReportPath = null,
  delayedPickupReportPath = null,
  visionTryOnReportPath = null,
  executedTracks = [],
} = {}) {
  const normalizedMode = requiredString(mode, "mode");
  if (!["fast", "full"].includes(normalizedMode)) {
    throw new Error("full workflow mode must be fast or full");
  }
  const fast = validateFastTrack(
    jsonReport(fastReportPath, "fast route"),
    fastReportPath,
  );
  let audio = skippedTrack("audio", "audio", "full mode only");
  let scanner = skippedTrack("scanner", "scanner", "full mode only");
  let vision = skippedTrack("vision", "Vision", "full mode only");
  let tryOn = skippedTrack("tryOn", "try-on", "full mode only");
  let error = failedTrack(
    "error",
    "error",
    fastReportPath,
    "fast route did not expose guarded error evidence",
  );
  if (fast.status === "passed") {
    error = passedTrack("error", "error", fastReportPath, {
      source: "fast route guarded navigation",
      guardedNavigationReason:
        jsonReport(fastReportPath, "fast route").summary?.guardedNavigationReason ??
        null,
    });
  }
  if (normalizedMode === "full") {
    audio = validateDelayedAudioTrack(
      jsonReport(delayedPickupReportPath, "delayed pickup"),
      delayedPickupReportPath,
    );
    const scanned = validateScannerTrack(
      jsonReport(scannerReportPath, "scanner payment-code"),
      scannerReportPath,
    );
    scanner = scanned.scanner;
    const visual = validateVisionTrack(
      jsonReport(visionTryOnReportPath, "vision try-on"),
      visionTryOnReportPath,
    );
    vision = visual.vision;
    tryOn = visual.tryOn;
    if (
      error.status === "passed" &&
      scanned.errorEvidence.status === "passed" &&
      visual.error.status === "passed"
    ) {
      error = passedTrack("error", "error", fastReportPath, {
        sources: [
          "fast route guarded navigation",
          "scanner malformed and timeout fail-closed",
          "vision and try-on degradation",
        ],
      });
    } else if (scanned.errorEvidence.status === "failed") {
      error = scanned.errorEvidence;
    } else if (visual.error.status === "failed") {
      error = visual.error;
    }
  }
  const tracks = { standardSale: fast, audio, scanner, vision, tryOn, error };
  const failures = Object.values(tracks)
    .filter((track) => track.status === "failed")
    .map((track) => ({
      track: track.key,
      label: track.label,
      reason: track.reason,
      reportPath: track.reportPath,
    }));
  return {
    schemaVersion: "vem-local-testbed-full-workflow/v2",
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
        "vision",
        "tryOn",
        "error",
      ],
      executedTracks,
    },
    tracks,
    failures,
  };
}
