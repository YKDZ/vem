import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ProcessRoleManifest } from "../../fault-injection.ts";
import type { BusinessSetReport } from "../../observation-record.ts";
import type { TestAdapter } from "../../test-adapter.ts";

import {
  redactSensitiveEvidenceText,
  sanitizeSensitiveEvidenceValue,
} from "../../../failure-evidence-redaction.ts";
import { EVIDENCE_LIMITS } from "../../../full-workflow-evidence-manifest.ts";
import { buildAcceptanceReport } from "../../acceptance-report.ts";
import { CdpTestAdapter } from "../../cdp-adapter.ts";
import { waitForCondition } from "../../condition-waiter.ts";
import { createProcessRoleManifest } from "../../fault-injection.ts";
import {
  BusinessSetProcessReplay,
  type ProcessReplaySummary,
} from "../../process-replay.ts";
import { parseSourceGarmentMetadata } from "./source-garment-evidence.ts";
import {
  createVisionAcceptanceBinding,
  runTryOnScenario,
  runDegradationScenario,
  runDepartureScenario,
  runManualCaptureScenario,
  runObserverSelfHealScenario,
  runRecordedResultGeometryScenario,
  type VisionAcceptanceBinding,
} from "./vision-experience-driver.ts";

type RecordedFixtureRestoreFailure = {
  kind: "vision-recorded-fixture-restore";
  status: "failed";
  stage: "restore-recorded-video-fixtures";
  reason: string;
};

type VisionExperienceReport = ReturnType<typeof buildAcceptanceReport>;

async function restoreRecordedVideoFixtures(
  adapter: TestAdapter,
): Promise<RecordedFixtureRestoreFailure | null> {
  try {
    const restored = await adapter.run("restore-recorded-video-fixtures");
    if (restored.exitCode === 0) return null;
    return {
      kind: "vision-recorded-fixture-restore",
      status: "failed",
      stage: "restore-recorded-video-fixtures",
      reason: restored.stderr || restored.stdout || "默认录播夹具恢复失败",
    };
  } catch (error) {
    return {
      kind: "vision-recorded-fixture-restore",
      status: "failed",
      stage: "restore-recorded-video-fixtures",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendRestoreFailure(
  report: VisionExperienceReport,
  restoreFailure: RecordedFixtureRestoreFailure,
): void {
  report.businessSets
    .find((entry) => entry.name === "visionExperience")
    ?.supportingEvidence.push(restoreFailure);
}

function primaryFailureWithRestore(
  primaryFailure: unknown,
  restoreFailure: RecordedFixtureRestoreFailure,
): Error & {
  stage: "vision-experience-primary";
  primaryFailure: unknown;
  restoreFailure: RecordedFixtureRestoreFailure;
  report: VisionExperienceReport | null;
  evidence: unknown;
} {
  const error = new Error(
    `visionExperience primary failure: ${
      primaryFailure instanceof Error
        ? primaryFailure.message
        : String(primaryFailure)
    }`,
    primaryFailure instanceof Error ? { cause: primaryFailure } : undefined,
  ) as Error & {
    stage: "vision-experience-primary";
    primaryFailure: unknown;
    restoreFailure: RecordedFixtureRestoreFailure;
    report: VisionExperienceReport | null;
    evidence: unknown;
  };
  error.stage = "vision-experience-primary";
  error.primaryFailure = primaryFailure;
  error.restoreFailure = restoreFailure;
  error.report = reportFromOperationalFailure(primaryFailure);
  if (error.report) appendRestoreFailure(error.report, restoreFailure);
  error.evidence =
    (primaryFailure as { evidence?: unknown } | null)?.evidence ?? null;
  return error;
}

function restoreOperationalFailure(
  report: VisionExperienceReport | null,
  restoreFailure: RecordedFixtureRestoreFailure,
): Error & {
  stage: "restore-recorded-video-fixtures";
  restoreFailure: RecordedFixtureRestoreFailure;
  report: VisionExperienceReport | null;
  primaryFailure: unknown;
} {
  const primaryFailure = report?.businessSets.find(
    (entry) => entry.name === "visionExperience",
  )?.primaryFailure;
  const error = new Error(
    `restore-recorded-video-fixtures failed: ${restoreFailure.reason}`,
  ) as Error & {
    stage: "restore-recorded-video-fixtures";
    restoreFailure: RecordedFixtureRestoreFailure;
    report: VisionExperienceReport | null;
    primaryFailure: unknown;
  };
  error.stage = "restore-recorded-video-fixtures";
  error.restoreFailure = restoreFailure;
  error.report = report;
  error.primaryFailure = primaryFailure ?? null;
  return error;
}

function reportFromOperationalFailure(
  error: unknown,
): VisionExperienceReport | null {
  const report = (error as { report?: unknown } | null)?.report;
  return report && typeof report === "object"
    ? (report as VisionExperienceReport)
    : null;
}

function restoreFailureFromOperationalFailure(
  error: unknown,
): RecordedFixtureRestoreFailure | null {
  const restoreFailure = (error as { restoreFailure?: unknown } | null)
    ?.restoreFailure;
  return restoreFailure && typeof restoreFailure === "object"
    ? (restoreFailure as RecordedFixtureRestoreFailure)
    : null;
}

function diagnosticsWithRestoreFailure(
  diagnostics: unknown,
  error: unknown,
): unknown {
  const restoreFailure = restoreFailureFromOperationalFailure(error);
  if (!restoreFailure) return diagnostics;
  const source =
    diagnostics &&
    typeof diagnostics === "object" &&
    !Array.isArray(diagnostics)
      ? (diagnostics as Record<string, unknown>)
      : {};
  const primaryFailure =
    source.primaryFailure ??
    (error as { primaryFailure?: unknown } | null)?.primaryFailure ??
    null;
  return { ...source, primaryFailure, restoreFailure };
}

function diagnosticsWithVisionAcceptanceFailure(
  diagnostics: unknown,
  error: unknown,
): unknown {
  const failure = error as {
    stage?: unknown;
    evidence?: unknown;
  } | null;
  if (
    (failure?.stage !== "vision-start-garment-binding" &&
      failure?.stage !== "vision-catalog-selection") ||
    !failure.evidence ||
    typeof failure.evidence !== "object"
  ) {
    return diagnostics;
  }
  const source =
    diagnostics &&
    typeof diagnostics === "object" &&
    !Array.isArray(diagnostics)
      ? (diagnostics as Record<string, unknown>)
      : {};
  return { ...source, visionAcceptanceFailure: failure.evidence };
}

/**
 * visionExperience 切片 runner：用同一 adapter 跑虚拟试衣与可选自愈场景，
 * 合并断言输出统一报告；fake 与真实 CDP adapter 共用。
 */
export async function runVisionExperienceSlice({
  adapter,
  acceptanceBinding,
  manifest = null,
  includeSelfHeal = false,
  includeGarmentScale = false,
  includeDegradation = false,
  includeManualCapture = false,
  includeDeparture = false,
  stopOwner = null,
  timeoutMs = 60_000,
  pollMs = 250,
  visionStabilityMs = 10_000,
  visionStabilityTimeoutMs = 60_000,
}: {
  adapter: TestAdapter;
  acceptanceBinding: VisionAcceptanceBinding;
  manifest?: ProcessRoleManifest | null;
  includeSelfHeal?: boolean;
  includeGarmentScale?: boolean;
  includeDegradation?: boolean;
  includeManualCapture?: boolean;
  includeDeparture?: boolean;
  stopOwner?: (() => void) | null;
  timeoutMs?: number;
  pollMs?: number;
  visionStabilityMs?: number;
  visionStabilityTimeoutMs?: number;
}) {
  let report: VisionExperienceReport | null = null;
  let primaryError: unknown = null;
  let hasPrimaryFailure = false;
  let geometryFixtureSelectionStarted = false;
  let restoreFailure: RecordedFixtureRestoreFailure | null = null;
  try {
    await waitForCondition(
      "vision-ready",
      async () => {
        try {
          const probe = await adapter.run("vision-ready");
          return { ok: probe?.exitCode === 0, value: probe?.stdout ?? null };
        } catch {
          return { ok: false, value: null };
        }
      },
      { timeoutMs: Math.max(timeoutMs, 300_000), pollMs: 1_000 },
    );
    await waitForVisionStable(adapter, {
      timeoutMs: visionStabilityTimeoutMs,
      stabilityMs: visionStabilityMs,
      pollMs: 1_000,
    });
    geometryFixtureSelectionStarted = includeGarmentScale;
    const geometry = includeGarmentScale
      ? await runRecordedResultGeometryScenario(adapter, {
          timeoutMs,
          pollMs,
          acceptanceBinding,
        })
      : null;
    if (geometry && !geometry.ok) {
      report = buildAcceptanceReport({
        runId: "slice-vision-experience",
        mode: "fast",
        pass: 1,
        businessSets: [
          {
            name: "visionExperience",
            assertions: geometry.assertions,
            supportingEvidence: [geometry.evidence],
          },
        ],
      });
    } else {
      const tryOn = geometry?.ok
        ? geometry.mid
        : await runTryOnScenario(adapter, {
            timeoutMs,
            pollMs,
            acceptanceBinding,
          });
      const assertions = [...tryOn.assertions];
      const supportingEvidence: unknown[] = [...tryOn.supportingEvidence];
      if (includeSelfHeal && manifest) {
        const heal = await runObserverSelfHealScenario(adapter, manifest, {
          timeoutMs,
          pollMs,
          acceptanceBinding,
        });
        assertions.push(...heal.assertions);
      }
      if (geometry) {
        assertions.push(...geometry.assertions);
        assertions.push(...geometry.scaleAssertions);
        assertions.push(...geometry.adjustmentAssertions);
        supportingEvidence.push(geometry.evidence);
      }
      if (includeDegradation && stopOwner) {
        const degradation = await runDegradationScenario(adapter, {
          stopOwner,
          timeoutMs,
          pollMs,
          acceptanceBinding,
        });
        assertions.push(...degradation.assertions);
      }
      if (includeManualCapture) {
        const manual = await runManualCaptureScenario(adapter, {
          timeoutMs,
          pollMs,
          acceptanceBinding,
        });
        assertions.push(...manual.assertions);
      }
      if (includeDeparture) {
        const departure = await runDepartureScenario(adapter, {
          timeoutMs,
          pollMs,
          acceptanceBinding,
        });
        assertions.push(...departure.assertions);
      }
      report = buildAcceptanceReport({
        runId: "slice-vision-experience",
        mode: "fast",
        pass: 1,
        businessSets: [
          { name: "visionExperience", assertions, supportingEvidence },
        ],
      });
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryFailure = true;
  } finally {
    // finally 只协调恢复；报告、主错误与 operational verdict 都在恢复完成后统一裁决。
    if (geometryFixtureSelectionStarted) {
      restoreFailure = await restoreRecordedVideoFixtures(adapter);
    }
  }
  if (hasPrimaryFailure) {
    if (restoreFailure) {
      throw primaryFailureWithRestore(primaryError, restoreFailure);
    }
    throw primaryError;
  }
  if (!report) {
    throw new Error("visionExperience slice completed without a report");
  }
  if (restoreFailure) {
    appendRestoreFailure(report, restoreFailure);
    throw restoreOperationalFailure(report, restoreFailure);
  }
  return report;
}

/**
 * 启动期竞态守卫：Vision 角色可能刚 ready 又立刻重启（owner 拉起/旧进程退出）。
 * 只有角色 PID 集合在 stabilityMs 窗口内保持不变，才认为 Vision 已经稳定，
 * 避免 attempt 发给正在重启的进程。这是有界条件等待，不是重试循环。
 */
export async function waitForVisionStable(
  adapter: TestAdapter,
  {
    timeoutMs = 60_000,
    stabilityMs = 10_000,
    pollMs = 1_000,
  }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number },
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastSignature: string | null = null;
  let stableSince: number | null = null;
  let lastObservation: { signature: string; exitCode: number } | null = null;
  while (Date.now() < deadline) {
    const probe = await adapter.run("vision-ready");
    if (probe.exitCode !== 0) {
      lastObservation = {
        signature: probe.stdout || probe.stderr || "unavailable",
        exitCode: probe.exitCode,
      };
      lastSignature = null;
      stableSince = null;
      await new Promise((resolvePromise) =>
        setTimeout(
          resolvePromise,
          Math.min(pollMs, Math.max(1, deadline - Date.now())),
        ),
      );
      continue;
    }
    let signature: string;
    try {
      const parsed = JSON.parse(probe.stdout ?? "");
      signature = JSON.stringify(parsed?.pids ?? null);
    } catch {
      // 非 JSON 的 fake 适配器不提供 PID 数据；仅成功 probe 可兼容此形状。
      return probe.stdout ?? "";
    }
    lastObservation = { signature, exitCode: probe.exitCode };
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - (stableSince ?? 0) >= stabilityMs) {
      return signature;
    }
    await new Promise((resolvePromise) =>
      setTimeout(
        resolvePromise,
        Math.min(pollMs, Math.max(1, deadline - Date.now())),
      ),
    );
  }
  const durationMs = Date.now() - startedAt;
  throw new Error(
    `vision-stable did not become true in ${timeoutMs} ms (observed ${durationMs} ms): ${JSON.stringify(lastObservation ?? null)}`,
  );
}

export function validateVisionExperienceSet(set: BusinessSetReport) {
  return {
    ok: set?.status === "passed",
    errors: set?.status === "failed" ? ["vision assertions failed"] : [],
  };
}

function boundedFailureDiagnosticValue(
  value: unknown,
  {
    depth = 0,
    maxDepth = 8,
    maxArrayEntries = 32,
    maxObjectEntries = 64,
    maxTextChars = 1_024,
  } = {},
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") {
    if (value.length <= maxTextChars) return value;
    return `${value.slice(0, maxTextChars)}…[truncated]`;
  }
  if (typeof value !== "object")
    return redactSensitiveEvidenceText(value, maxTextChars);
  if (depth >= maxDepth) return "[bounded]";
  const nextOptions = {
    depth: depth + 1,
    maxDepth,
    maxArrayEntries,
    maxObjectEntries,
    maxTextChars,
  };
  if (Array.isArray(value)) {
    return value
      .slice(-maxArrayEntries)
      .map((entry) => boundedFailureDiagnosticValue(entry, nextOptions));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxObjectEntries)
      .map(([key, entry]) => [
        key,
        boundedFailureDiagnosticValue(entry, nextOptions),
      ]),
  );
}

function diagnosticCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function serializeFailureDiagnostics(diagnostics: unknown): string {
  const safe = sanitizeSensitiveEvidenceValue(diagnostics) ?? null;
  const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const complete = serialize(safe);
  if (Buffer.byteLength(complete) <= EVIDENCE_LIMITS.reportPerFileBytes) {
    return complete;
  }

  const source =
    safe && typeof safe === "object" && !Array.isArray(safe)
      ? (safe as Record<string, unknown>)
      : {};
  const cdp =
    source.cdp && typeof source.cdp === "object" && !Array.isArray(source.cdp)
      ? (source.cdp as Record<string, unknown>)
      : {};
  const compact = boundedFailureDiagnosticValue({
    schemaVersion:
      source.schemaVersion ?? "vem-vision-experience-failure-diagnostics/v1",
    capturedAt: source.capturedAt ?? new Date().toISOString(),
    diagnosticsTruncated: true,
    originalByteLength: Buffer.byteLength(complete),
    error: source.error ?? null,
    milestones: source.milestones ?? [],
    stateObservations: source.stateObservations ?? [],
    lastDomState: source.lastDomState ?? null,
    machineRuntimeTraceSnapshot: source.machineRuntimeTraceSnapshot ?? null,
    machineRuntimeTrace: source.machineRuntimeTrace ?? [],
    cdp: {
      console: cdp.console ?? [],
      exceptions: cdp.exceptions ?? [],
      networkErrors: cdp.networkErrors ?? [],
    },
    vision: source.vision ?? null,
    fixtureRestarts: source.fixtureRestarts ?? [],
  });
  const compactSerialized = serialize(compact);
  if (
    Buffer.byteLength(compactSerialized) <= EVIDENCE_LIMITS.reportPerFileBytes
  ) {
    return compactSerialized;
  }

  const minimalOptions = {
    maxDepth: 5,
    maxArrayEntries: 1,
    maxObjectEntries: 32,
    maxTextChars: 256,
  };
  const minimal = {
    schemaVersion:
      source.schemaVersion ?? "vem-vision-experience-failure-diagnostics/v1",
    capturedAt: source.capturedAt ?? new Date().toISOString(),
    diagnosticsTruncated: true,
    originalByteLength: Buffer.byteLength(complete),
    error: boundedFailureDiagnosticValue(source.error ?? null, minimalOptions),
    lastDomState: boundedFailureDiagnosticValue(
      source.lastDomState ?? null,
      minimalOptions,
    ),
    machineRuntimeTrace: boundedFailureDiagnosticValue(
      source.machineRuntimeTrace ?? [],
      minimalOptions,
    ),
    cdp: {
      console: boundedFailureDiagnosticValue(cdp.console ?? [], minimalOptions),
      exceptions: boundedFailureDiagnosticValue(
        cdp.exceptions ?? [],
        minimalOptions,
      ),
      networkErrors: boundedFailureDiagnosticValue(
        cdp.networkErrors ?? [],
        minimalOptions,
      ),
    },
    vision: boundedFailureDiagnosticValue(
      source.vision ?? null,
      minimalOptions,
    ),
    diagnosticCounts: {
      milestones: diagnosticCount(source.milestones),
      stateObservations: diagnosticCount(source.stateObservations),
      machineRuntimeTrace: diagnosticCount(source.machineRuntimeTrace),
      console: diagnosticCount(cdp.console),
      exceptions: diagnosticCount(cdp.exceptions),
      networkErrors: diagnosticCount(cdp.networkErrors),
      fixtureRestarts: diagnosticCount(source.fixtureRestarts),
    },
  };
  const minimalSerialized = serialize(minimal);
  if (
    Buffer.byteLength(minimalSerialized) <= EVIDENCE_LIMITS.reportPerFileBytes
  ) {
    return minimalSerialized;
  }
  return `${JSON.stringify({
    schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
    capturedAt: new Date().toISOString(),
    diagnosticsTruncated: true,
    error: { message: "failure diagnostics exceeded the storage budget" },
  })}\n`;
}

/**
 * guest-input 不提供顶层 API 地址；以 Runtime Bootstrap 为唯一权威来源，
 * 把带 /api 路径的 provisioning URL 规范化为 Service API origin。
 */
export function sourceGarmentBindingFromGuestInput(guestInput: unknown): {
  selectedCatalogKey: string;
  selectedVariantId: string;
  selectedSize: string;
  sourceGarmentMetadata: NonNullable<
    ReturnType<typeof parseSourceGarmentMetadata>
  >;
  sourceGarmentServiceApiOrigin: string;
} {
  const input = guestInput as {
    runtimeBootstrap?: { provisioningApiBaseUrl?: unknown };
    visionAcceptance?: {
      selectedCatalogKey?: unknown;
      selectedVariantId?: unknown;
      seededTryOnVariants?: unknown;
      sourceGarment?: unknown;
    };
  } | null;
  const provisioningApiBaseUrl =
    input?.runtimeBootstrap?.provisioningApiBaseUrl;
  try {
    if (typeof provisioningApiBaseUrl !== "string") {
      throw new Error("runtime bootstrap provisioning URL is missing");
    }
    const serviceApiUrl = new URL(provisioningApiBaseUrl);
    if (
      serviceApiUrl.protocol !== "http:" &&
      serviceApiUrl.protocol !== "https:"
    ) {
      throw new Error("Service API origin must use HTTP(S)");
    }
    const seeded = input?.visionAcceptance?.sourceGarment;
    if (!seeded || typeof seeded !== "object" || Array.isArray(seeded)) {
      throw new Error("source garment seed is missing");
    }
    const publicPath = (seeded as { publicPath?: unknown }).publicPath;
    if (typeof publicPath !== "string" || !publicPath.startsWith("/")) {
      throw new Error("source garment publicPath must be origin-relative");
    }
    const reference = new URL(publicPath, serviceApiUrl.origin);
    const assetId = (seeded as { assetId?: unknown }).assetId;
    if (
      reference.origin !== serviceApiUrl.origin ||
      typeof assetId !== "string" ||
      reference.pathname !== `/api/media-assets/${assetId}/content` ||
      reference.search !== "" ||
      reference.hash !== ""
    ) {
      throw new Error("source garment publicPath is not canonical");
    }
    const sourceGarmentMetadata = parseSourceGarmentMetadata(
      {
        ...seeded,
        reference: reference.toString(),
        origin: serviceApiUrl.origin,
      },
      serviceApiUrl.origin,
    );
    if (!sourceGarmentMetadata) {
      throw new Error("source garment metadata is invalid");
    }
    const selectedVariantId = input?.visionAcceptance?.selectedVariantId;
    const seededTryOnVariants = input?.visionAcceptance?.seededTryOnVariants;
    if (!Array.isArray(seededTryOnVariants)) {
      throw new Error("seeded try-on variants are missing");
    }
    const selectedRecords = seededTryOnVariants.filter(
      (record) =>
        record !== null &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        (record as { variantId?: unknown }).variantId === selectedVariantId,
    );
    if (selectedRecords.length !== 1) {
      throw new Error("selected try-on variant must have one seed record");
    }
    const selectedRecord = selectedRecords[0] as {
      productId?: unknown;
      size?: unknown;
      garmentMediaAssetId?: unknown;
    };
    if (
      input?.visionAcceptance?.selectedCatalogKey !==
        `product:${selectedRecord.productId}` ||
      selectedRecord.garmentMediaAssetId !== sourceGarmentMetadata.assetId
    ) {
      throw new Error("selected try-on variant is not bound to source garment");
    }
    return {
      ...createVisionAcceptanceBinding({
        selectedCatalogKey: input?.visionAcceptance?.selectedCatalogKey,
        selectedVariantId,
        selectedSize: selectedRecord.size,
        sourceGarmentMetadata,
      }),
      sourceGarmentServiceApiOrigin: serviceApiUrl.origin,
    };
  } catch (error) {
    throw new Error("vision acceptance binding is invalid", { cause: error });
  }
}

/**
 * VM 轨道入口：从环境读取 CDP 与 Vision 地址，运行全部业务场景并输出 v2 报告。
 */
async function persistFailureEvidence({
  adapter,
  artifactRoot,
  error,
  io = { mkdir, writeFile },
}: {
  adapter: CdpTestAdapter & {
    captureFailureEvidence?: (error: unknown) => Promise<{
      diagnostics: unknown;
      screenshotPng: Buffer | null;
    }>;
  };
  artifactRoot: string | null;
  error: unknown;
  io?: {
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
  };
}): Promise<string | null> {
  if (!artifactRoot) return null;
  try {
    await io.mkdir(artifactRoot, { recursive: true });
    const diagnosticsPath = join(artifactRoot, "failure-diagnostics.json");
    let failureEvidence: {
      diagnostics: unknown;
      screenshotPng: Buffer | null;
    };
    try {
      if (typeof adapter.captureFailureEvidence !== "function") {
        throw new Error("adapter has no failure evidence boundary");
      }
      failureEvidence = await adapter.captureFailureEvidence(error);
    } catch {
      // 普通子进程 stderr 仍会保留；丰富诊断不可用时不序列化未脱敏异常。
      failureEvidence = {
        diagnostics: {
          schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
          capturedAt: new Date().toISOString(),
          error: { message: "failure evidence capture was unavailable" },
        },
        screenshotPng: null,
      };
    }
    failureEvidence.diagnostics = diagnosticsWithRestoreFailure(
      failureEvidence.diagnostics,
      error,
    );
    failureEvidence.diagnostics = diagnosticsWithVisionAcceptanceFailure(
      failureEvidence.diagnostics,
      error,
    );
    await io.writeFile(
      diagnosticsPath,
      serializeFailureDiagnostics(failureEvidence.diagnostics),
      "utf8",
    );
    if (failureEvidence.screenshotPng) {
      await io.writeFile(
        join(artifactRoot, "failure-screenshot.png"),
        failureEvidence.screenshotPng,
      );
    }
    return diagnosticsPath;
  } catch {
    // 支持证据只做尽力采集，不得替换业务异常或改变 runner 控制流。
    return null;
  }
}

export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: {
    startVisionOwner?: () => unknown;
    createAdapter?: (options: Record<string, unknown>) => CdpTestAdapter;
    runSlice?: typeof runVisionExperienceSlice;
    runReplay?: <T>(
      context: Parameters<typeof BusinessSetProcessReplay.run>[0],
      operation: () => Promise<T> | T,
    ) => Promise<T>;
    failureIo?: {
      mkdir: typeof mkdir;
      writeFile: typeof writeFile;
    };
  } = {},
) {
  const outIndex = args.indexOf("--out");
  const outPath: string | null = outIndex >= 0 ? args[outIndex + 1] : null;
  const artifactRoot = outPath
    ? join(dirname(outPath), "vision-experience-artifacts")
    : null;
  const modeIndex = args.indexOf("--mode");
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : "fast";
  const replayDirectory = process.env.VEM_PROCESS_REPLAY_DIR ?? null;
  const replayEnabled =
    mode === "fast" &&
    process.env.VEM_PROCESS_REPLAY === "1" &&
    outPath !== null &&
    replayDirectory !== null;
  // 重建后的 VM 可能尚未启动 Vision 默认 owner；轨道负责启动并等待就绪。
  await Promise.resolve(
    (
      dependencies.startVisionOwner ??
      (() =>
        spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Start-ScheduledTask -TaskName VEMVisionRuntime",
          ],
          { stdio: "ignore" },
        ))
    )(),
  );
  const guestInputIndex = args.indexOf("--guest-input");
  const guestInputPath =
    guestInputIndex >= 0 ? args[guestInputIndex + 1] : null;
  if (!guestInputPath) {
    throw new Error("vision acceptance binding requires --guest-input");
  }
  const acceptanceBinding = sourceGarmentBindingFromGuestInput(
    JSON.parse(readFileSync(guestInputPath, "utf8")),
  );
  const { sourceGarmentMetadata, sourceGarmentServiceApiOrigin } =
    acceptanceBinding;
  const adapter = (
    dependencies.createAdapter ?? ((options) => new CdpTestAdapter(options))
  )({
    sourceGarmentMetadata,
    sourceGarmentServiceApiOrigin,
  });
  let replaySummary: ProcessReplaySummary | null = null;
  adapter.recordMilestone?.("runner:connect", "started");
  try {
    await adapter.connect({ timeoutMs: 20_000 });
    adapter.recordMilestone?.("runner:connect", "completed");
    const manifest = createProcessRoleManifest({
      roles: {
        observer: {
          stopCommand: ["stop-vision-role", "--role", "observer"],
          probeCommand: ["probe-vision-role", "observer"],
        },
      },
    });
    adapter.recordMilestone?.("runner:slice", "started");
    const executeSlice = () =>
      (dependencies.runSlice ?? runVisionExperienceSlice)({
        adapter,
        acceptanceBinding,
        manifest,
        includeSelfHeal: process.env.SKIP_SELF_HEAL !== "1",
        includeGarmentScale: process.env.SKIP_SCALE !== "1",
        includeDegradation: process.env.RUN_DEGRADATION === "1",
        includeManualCapture: process.env.RUN_MANUAL === "1",
        includeDeparture: process.env.RUN_DEPARTURE === "1",
        stopOwner: () => {
          spawnSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              "Stop-ScheduledTask -TaskName VEMVisionRuntime -ErrorAction Stop",
            ],
            { stdio: "ignore" },
          );
        },
        timeoutMs: 60_000,
        pollMs: 250,
        visionStabilityMs: Number(process.env.VISION_STABILITY_MS ?? 10_000),
        visionStabilityTimeoutMs: Number(
          process.env.VISION_STABILITY_TIMEOUT_MS ?? 60_000,
        ),
      });
    const report = replayEnabled
      ? await (dependencies.runReplay ?? BusinessSetProcessReplay.run)(
          {
            endpoint: adapter.endpoint,
            outputDirectory: replayDirectory!,
            businessSet: "visionExperience",
            onSummary: (summary) => {
              replaySummary = summary;
            },
          },
          executeSlice,
        )
      : await executeSlice();
    if (replaySummary) {
      report.businessSets
        .find((entry) => entry.name === "visionExperience")
        ?.supportingEvidence.push({
          kind: "business-set-process-replay",
          summary: replaySummary,
        });
    }
    adapter.recordMilestone?.(
      "runner:slice",
      report.ok === true ? "completed" : "failed",
      { reportOk: report.ok },
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outPath) {
      await writeFile(outPath, serialized, "utf8");
    }
    if (report.ok !== true) {
      const diagnosticsPath = await persistFailureEvidence({
        adapter,
        artifactRoot,
        error: new Error("visionExperience business assertions failed"),
        io: dependencies.failureIo,
      });
      if (diagnosticsPath) {
        process.stderr.write(
          `visionExperience supportingEvidence=${diagnosticsPath}\n`,
        );
      }
    }
    process.stdout.write(serialized);
    // 轨道结束后恢复基线：Machine UI 回到 Catalog，避免干扰后续轨道。
    await adapter.run("navigate", ["#/catalog"]).catch(() => {});
  } catch (error) {
    const failedReport = reportFromOperationalFailure(error);
    if (failedReport && outPath) {
      if (replaySummary) {
        failedReport.businessSets
          .find((entry) => entry.name === "visionExperience")
          ?.supportingEvidence.push({
            kind: "business-set-process-replay",
            summary: replaySummary,
          });
      }
      await writeFile(
        outPath,
        `${JSON.stringify(failedReport, null, 2)}\n`,
        "utf8",
      );
    }
    adapter.recordMilestone?.("runner:slice", "failed", {
      message: error instanceof Error ? error.message : String(error),
      restoreFailure: restoreFailureFromOperationalFailure(error),
    });
    const diagnosticsPath = await persistFailureEvidence({
      adapter,
      artifactRoot,
      error,
      io: dependencies.failureIo,
    });
    if (diagnosticsPath) {
      process.stderr.write(
        `visionExperience supportingEvidence=${diagnosticsPath}\n`,
      );
    }
    throw error;
  } finally {
    await adapter.close();
  }
}

if (
  typeof import.meta !== "undefined" &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
