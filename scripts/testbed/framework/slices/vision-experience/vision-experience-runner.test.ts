import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildAcceptanceReport } from "../../acceptance-report.ts";
import { createBusinessCheckRegistryV2 } from "../../business-check-registry-v2.ts";
import { businessAssertion } from "../../observation-record.ts";
import { createFakeTestAdapter } from "../../test-adapter.ts";
import {
  sourceGarmentBindingFromGuestInput,
  main as runVisionExperienceMain,
  runVisionExperienceSlice,
  waitForVisionStable,
} from "./vision-experience-runner.ts";

const tryOnAttemptId = "550e8400-e29b-41d4-a716-446655440124";
const selectedCatalogKey = "product:550e8400-e29b-41d4-a716-446655440125";
const selectedVariantId = "550e8400-e29b-41d4-a716-446655440127";
const sourceGarmentMetadataFixture = {
  reference:
    "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
  origin: "http://127.0.0.1:26849",
  assetId: "550e8400-e29b-41d4-a716-446655440126",
  digest: `sha256:${"a".repeat(64)}`,
  contentType: "image/png" as const,
  byteSize: 12,
  template: "tshirt_short_sleeve" as const,
  width: 512,
  height: 640,
};
const visionAcceptanceBinding = {
  selectedCatalogKey,
  selectedVariantId,
  selectedSize: "M",
  sourceGarmentMetadata: sourceGarmentMetadataFixture,
};
const selectedProductSelector =
  `[data-test="catalog-product"]` +
  `[data-catalog-key="${selectedCatalogKey}"]`;
const selectedProductRoute = `#/products/${encodeURIComponent(
  selectedCatalogKey,
)}?variantId=${selectedVariantId}`;

function writeVisionGuestInput(root: string): string {
  const path = join(root, "guest-input.json");
  writeFileSync(
    path,
    JSON.stringify({
      runtimeBootstrap: {
        provisioningApiBaseUrl: "http://127.0.0.1:26849/api",
      },
      visionAcceptance: {
        selectedCatalogKey,
        selectedVariantId,
        seededTryOnVariants: [
          {
            productId: selectedCatalogKey.slice("product:".length),
            variantId: selectedVariantId,
            size: visionAcceptanceBinding.selectedSize,
            garmentMediaAssetId: sourceGarmentMetadataFixture.assetId,
          },
        ],
        sourceGarment: {
          ...sourceGarmentMetadataFixture,
          publicPath: new URL(sourceGarmentMetadataFixture.reference).pathname,
        },
      },
    }),
  );
  return path;
}

function passedVisionReport() {
  return buildAcceptanceReport({
    runId: "replay-integration",
    mode: "fast",
    pass: 1,
    businessSets: [
      {
        name: "visionExperience",
        assertions: [
          businessAssertion({
            id: "replay-passthrough",
            source: "integration",
            expected: true,
            observed: true,
          }),
        ],
      },
    ],
  });
}

function replaySummaryFixture(overrides = {}) {
  return {
    status: "completed",
    reason: null,
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:01.000Z",
    durationMs: 1_000,
    framesReceived: 3,
    framesWritten: 3,
    framesDropped: 0,
    framesSkipped: 0,
    bytesWritten: 3_000,
    truncated: false,
    firstFrameTimestampMs: 1_000,
    lastFrameTimestampMs: 2_000,
    outputDirectory: "/tmp/replay",
    capturePath: "/tmp/replay/capture.json",
    playerPath: "/tmp/replay/player.html",
    ...overrides,
  };
}

function capturedEvidenceFor(attemptId: string) {
  const visionOrigin = "http://127.0.0.1:7892";
  const requestId = "vision-websocket-1";
  const captured = {
    reference: `${visionOrigin}/v2/try-on/captured/frame.png?token=captured-token`,
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 4096,
    width: 720,
    height: 1280,
    frameId: "frame-000042",
  };
  const result = {
    reference: `${visionOrigin}/v2/try-on/results/${attemptId}?token=result-token`,
    digest: `sha256:${"b".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 8192,
    width: 720,
    height: 1280,
  };
  return {
    visionOrigin,
    protocolTimeline: [
      {
        type: "vision.try_on.attempt.accepted",
        requestId,
        origin: visionOrigin,
        payload: { attemptId },
      },
      {
        type: "vision.try_on.attempt.acquiring",
        requestId,
        origin: visionOrigin,
        payload: {
          attemptId,
          preview: {
            reference: `${visionOrigin}/v2/try-on/acquisition/preview.mjpeg?token=preview-token`,
            streamType: "mjpeg",
          },
          occupancy: "single",
          guidance: "counting_down",
          manualCaptureAllowed: true,
          holdRemainingMs: 3_000,
        },
      },
      {
        type: "vision.try_on.attempt.captured",
        requestId,
        origin: visionOrigin,
        payload: { attemptId, captured },
      },
      {
        type: "vision.try_on.attempt.generating",
        requestId,
        origin: visionOrigin,
        payload: { attemptId, stage: "generating" },
      },
      {
        type: "vision.try_on.attempt.completed",
        requestId,
        origin: visionOrigin,
        payload: { attemptId, result },
      },
    ],
    capturedResource: {
      attemptId,
      capturedDigest: captured.digest,
      capturedFrameId: captured.frameId,
      visionOrigin,
      reference: captured.reference,
      finalUrl: captured.reference,
      ok: true,
      httpStatus: 200,
      contentType: "image/png" as const,
      byteSize: captured.byteSize,
      digest: captured.digest,
      width: captured.width,
      height: captured.height,
    },
  };
}

function observationTimelineFor(attemptId: string) {
  const held = {
    capturedVisible: true,
    capturedNaturalWidth: 720,
    capturedNaturalHeight: 1280,
    capturedSourceMatchesProtocol: true,
    capturedSourceDigest: "sha256:captured-source",
    capturedFrameHash: "sha256:captured-frame",
    capturedFrameId: "frame-000042",
    capturedDigest: `sha256:${"a".repeat(64)}`,
  };
  return [
    [0, 3_000, "3", "preview-3a"],
    [750, 2_250, "3", "preview-3b"],
    [1_000, 2_000, "2", "preview-2a"],
    [1_750, 1_250, "2", "preview-2b"],
    [2_000, 1_000, "1", "preview-1a"],
    [2_750, 250, "1", "preview-1b"],
  ]
    .map(([atMs, holdRemainingMs, countdownText, previewFrameHash]) => ({
      atMs,
      attemptId,
      state: "acquiring",
      holdRemainingMs,
      countdownText,
      previewVisible: true,
      previewFrameHash,
    }))
    .concat([
      {
        atMs: 3_000,
        attemptId,
        state: "captured",
        holdRemainingMs: null,
        countdownText: null,
        previewVisible: false,
        previewFrameHash: null,
        ...held,
      },
      {
        atMs: 3_200,
        attemptId,
        state: "generating",
        holdRemainingMs: null,
        countdownText: null,
        previewVisible: false,
        previewFrameHash: null,
        ...held,
      },
    ]);
}

function fakeUiAdapter() {
  const statePath = "ui/try-on-state.json";
  let selectedSegment: "far" | "mid" | "near" = "mid";
  const segmentScale = { far: 0.8, mid: 1, near: 1.2 } as const;
  const segmentAttemptId = {
    far: "550e8400-e29b-41d4-a716-446655440121",
    mid: tryOnAttemptId,
    near: "550e8400-e29b-41d4-a716-446655440123",
  } as const;
  const resultPng = (scale: number) => ({
    width: 720,
    height: 1280,
    leftSleevePixels: 120,
    torsoPixels: 1_200,
    rightSleevePixels: 120,
    garment: {
      x: 360 - Math.round(100 * scale) / 2,
      y: 640 - Math.round(125 * scale) / 2,
      width: Math.round(100 * scale),
      height: Math.round(125 * scale),
      centerX: 359.5,
      centerY: 639.5,
      aspect: 0.8,
    },
  });
  const sourceGarmentMetadata = sourceGarmentMetadataFixture;
  const startGarment = {
    assetId: sourceGarmentMetadata.assetId,
    reference: "http://127.0.0.1:7892/media/garment?token=source-token",
    digest: sourceGarmentMetadata.digest,
    contentType: sourceGarmentMetadata.contentType,
    byteSize: sourceGarmentMetadata.byteSize,
    template: sourceGarmentMetadata.template,
  };
  const adapter = createFakeTestAdapter({
    files: {
      [statePath]: JSON.stringify({ route: "#/catalog", state: "idle" }),
    },
    commands: {
      "vision-ready": () => ({ exitCode: 0, stdout: "ready", stderr: "" }),
      "select-recorded-video-fixture far": () => {
        selectedSegment = "far";
        return { exitCode: 0, stdout: "far", stderr: "" };
      },
      "select-recorded-video-fixture mid": () => {
        selectedSegment = "mid";
        return { exitCode: 0, stdout: "mid", stderr: "" };
      },
      "select-recorded-video-fixture near": () => {
        selectedSegment = "near";
        return { exitCode: 0, stdout: "near", stderr: "" };
      },
      "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      'click [data-test="catalog-category"][data-category-key="tshirts"]':
        async () => {
          await adapter.writeFile(
            statePath,
            JSON.stringify({ route: "#/catalog", state: "idle" }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      'click [data-test="catalog-product"]': async () => {
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: "#/products/product:1",
            state: "idle",
            tryOnPresent: true,
            buyDisabled: false,
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      [`click ${selectedProductSelector}`]: async () => {
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: selectedProductRoute,
            catalogKey: selectedCatalogKey,
            variantId: selectedVariantId,
            state: "idle",
            tryOnPresent: true,
            buyDisabled: false,
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="try-on"]': async () => {
        const attemptId = segmentAttemptId[selectedSegment];
        const resultReference = `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`;
        const capturedEvidence = capturedEvidenceFor(attemptId);
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
            state: "acquiring",
            attemptId,
            preview: { naturalWidth: 720, naturalHeight: 1280 },
            startGarment,
          }),
        );
        setTimeout(() => {
          void adapter.writeFile(
            statePath,
            JSON.stringify({
              route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
              state: "completed",
              attemptId,
              preview: { naturalWidth: 720, naturalHeight: 1280 },
              resultUrl: resultReference,
              resultPng: resultPng(segmentScale[selectedSegment]),
              sourceGarmentPng: resultPng(1),
              sourceGarmentMetadata,
              startGarment,
              observationTimeline: observationTimelineFor(attemptId),
              ...capturedEvidence,
            }),
          );
        }, 50);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="try-on-scale-up"]': async () => {
        const current = JSON.parse(await adapter.readFile(statePath));
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            ...current,
            scaleValue: "105%",
            resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${current.attemptId}?token=105`,
            resultPng: resultPng(1.05),
            adjustmentEvidence: {
              scales: [1.05],
              results: [
                {
                  reference: `http://127.0.0.1:7892/v2/try-on/results/${current.attemptId}?token=105`,
                },
              ],
            },
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  return adapter;
}

describe("visionExperience slice runner", () => {
  it("轨道在报告前退出时写入诊断与截图", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-runner-failure-"));
    const outPath = join(root, "vision-experience.json");
    const guestInputPath = writeVisionGuestInput(root);
    const screenshot = readFileSync(
      new URL(
        "../../../../../apps/machine/src-tauri/app-icon.png",
        import.meta.url,
      ),
    );
    const milestones: unknown[] = [];
    const adapter = {
      async connect() {
        return this;
      },
      async close() {},
      recordMilestone(stage: string, status: string) {
        milestones.push({ stage, status });
      },
      async captureFailureEvidence() {
        return {
          diagnostics: {
            schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
            lastDomState: {
              route: "#/products/product:1",
              state: null,
              attemptId: null,
            },
            milestones,
            machineRuntimeTrace: [{ kind: "navigation" }],
            cdp: { console: [], exceptions: [], networkErrors: [] },
            vision: {
              listener: { reachable: false },
              roles: [],
            },
          },
          screenshotPng: screenshot,
        };
      },
      async readFile() {
        return "{}";
      },
      async writeFile() {},
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    try {
      await assert.rejects(
        runVisionExperienceMain(
          ["--out", outPath, "--guest-input", guestInputPath],
          {
            startVisionOwner: () => undefined,
            createAdapter: () => adapter,
            runSlice: async () => {
              const error = new Error(
                "try-on-route did not become true",
              ) as Error & { stage: string; evidence: unknown };
              error.stage = "vision-start-garment-binding";
              error.evidence = {
                kind: "vision-start-garment-binding",
                status: "mismatch",
                selection: {
                  catalogKey: selectedCatalogKey,
                  variantId: selectedVariantId,
                },
                expected: { template: "tshirt_short_sleeve" },
                observed: { template: "tshirt_long_sleeve" },
              };
              throw error;
            },
          },
        ),
        /try-on-route/,
      );
      const artifactRoot = join(root, "vision-experience-artifacts");
      const diagnostics = JSON.parse(
        readFileSync(join(artifactRoot, "failure-diagnostics.json"), "utf8"),
      );
      assert.equal(diagnostics.lastDomState.route, "#/products/product:1");
      assert.deepEqual(diagnostics.machineRuntimeTrace, [
        { kind: "navigation" },
      ]);
      assert.equal(
        diagnostics.visionAcceptanceFailure.selection.variantId,
        selectedVariantId,
      );
      assert.equal(
        diagnostics.visionAcceptanceFailure.observed.template,
        "tshirt_long_sleeve",
      );
      assert.ok(
        readFileSync(join(artifactRoot, "failure-screenshot.png")).equals(
          screenshot,
        ),
      );
      assert.equal(rmSync(outPath, { force: true }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("主 geometry verdict 与 restore 失败会在同一轮恢复后再落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-runner-restore-"));
    const outPath = join(root, "vision-experience.json");
    const guestInputPath = writeVisionGuestInput(root);
    const milestones: Record<string, unknown>[] = [];
    const adapter = fakeUiAdapter() as any;
    const originalRun = adapter.run.bind(adapter);
    adapter.connect = async () => adapter;
    adapter.close = async () => {};
    adapter.recordMilestone = (
      stage: string,
      status: string,
      detail = null,
    ) => {
      milestones.push({ stage, status, detail });
    };
    adapter.captureFailureEvidence = async () => ({
      diagnostics: {
        schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
        milestones,
        primaryFailure: {
          stage: "recorded-geometry-fixture",
          reason: "geometry fixture blocked",
        },
        cdp: { console: [], exceptions: [], networkErrors: [] },
      },
      screenshotPng: null,
    });
    adapter.run = async (command: string, args = []) => {
      const result =
        command === "select-recorded-video-fixture"
          ? { exitCode: 1, stdout: "", stderr: "geometry fixture blocked" }
          : command === "restore-recorded-video-fixtures"
            ? { exitCode: 1, stdout: "", stderr: "restore failed" }
            : await originalRun(command, args);
      milestones.push({
        stage: `adapter:${command}`,
        status: result.exitCode === 0 ? "completed" : "failed",
        detail: result.stderr || result.stdout || null,
      });
      return result;
    };
    try {
      await assert.rejects(
        runVisionExperienceMain(
          ["--out", outPath, "--guest-input", guestInputPath],
          {
            startVisionOwner: () => undefined,
            createAdapter: () => adapter,
            runSlice: (options) => runVisionExperienceSlice(options),
          },
        ),
        (error: any) =>
          error?.stage === "restore-recorded-video-fixtures" &&
          error?.report?.businessSets?.[0]?.status === "failed" &&
          error?.restoreFailure?.reason === "restore failed",
      );
      const report = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(report.businessSets[0].status, "failed");
      assert.deepEqual(report.businessSets[0].supportingEvidence.at(-1), {
        kind: "vision-recorded-fixture-restore",
        status: "failed",
        stage: "restore-recorded-video-fixtures",
        reason: "restore failed",
      });
      const diagnostics = JSON.parse(
        readFileSync(
          join(root, "vision-experience-artifacts", "failure-diagnostics.json"),
          "utf8",
        ),
      );
      assert.equal(
        diagnostics.primaryFailure.stage,
        "recorded-geometry-fixture",
      );
      assert.deepEqual(diagnostics.restoreFailure, {
        kind: "vision-recorded-fixture-restore",
        status: "failed",
        stage: "restore-recorded-video-fixtures",
        reason: "restore failed",
      });
      const stages = diagnostics.milestones
        .map((entry: { stage?: string }) => entry.stage)
        .filter((stage: string) => stage.startsWith("adapter:"));
      assert.deepEqual(stages.slice(-2), [
        "adapter:select-recorded-video-fixture",
        "adapter:restore-recorded-video-fixtures",
      ]);
      assert.match(
        readFileSync(outPath, "utf8"),
        /vision-recorded-fixture-restore/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("支持证据目录或文件无法写入时不替换业务错误", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-runner-io-failure-"));
    const guestInputPath = writeVisionGuestInput(root);
    const attempted: string[] = [];
    const adapter = {
      async connect() {
        return this;
      },
      async close() {},
      recordMilestone() {},
      async captureFailureEvidence() {
        return { diagnostics: {}, screenshotPng: null };
      },
      async readFile() {
        return "{}";
      },
      async writeFile() {},
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    try {
      for (const failureIo of [
        {
          mkdir: async () => {
            attempted.push("mkdir");
            throw new Error("diagnostic disk is full");
          },
          writeFile: async () => undefined,
        },
        {
          mkdir: async () => undefined,
          writeFile: async () => {
            attempted.push("writeFile");
            throw new Error("diagnostic write failed");
          },
        },
      ]) {
        await assert.rejects(
          runVisionExperienceMain(
            [
              "--out",
              join(root, "vision-experience.json"),
              "--guest-input",
              guestInputPath,
            ],
            {
              startVisionOwner: () => undefined,
              createAdapter: () => adapter,
              runSlice: async () => {
                throw new Error("try-on-route did not become true");
              },
              failureIo,
            },
          ),
          (error: Error) =>
            error.message === "try-on-route did not become true",
        );
      }
      assert.deepEqual(attempted, ["mkdir", "writeFile"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("失败诊断整体超限时保留有界摘要而不写入超大文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-runner-bounded-"));
    const outPath = join(root, "vision-experience.json");
    const guestInputPath = writeVisionGuestInput(root);
    const consoleEvents = Array.from({ length: 128 }, (_, eventIndex) => ({
      type: "log",
      args: Array.from(
        { length: 16 },
        (_, argumentIndex) =>
          `console-${eventIndex}-${argumentIndex}-${"x".repeat(2_048)}`,
      ),
    }));
    const diagnostics = {
      schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
      capturedAt: new Date().toISOString(),
      error: { message: "result-surface timed out" },
      milestones: [{ stage: "result-surface", status: "failed" }],
      stateObservations: [
        { route: "#/try-on", state: "generating", attemptId: "attempt-1" },
      ],
      lastDomState: {
        route: "#/try-on",
        state: "generating",
        attemptId: "attempt-1",
      },
      machineRuntimeTrace: [{ kind: "navigation", route: "#/try-on" }],
      cdp: { console: consoleEvents, exceptions: [], networkErrors: [] },
      vision: {
        listener: { reachable: true, httpStatus: 200 },
        roles: [{ name: "api", pid: 42, ready: true }],
      },
      fixtureRestarts: [],
    };
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) > 2 * 1024 * 1024);
    const adapter = {
      async connect() {
        return this;
      },
      async close() {},
      recordMilestone() {},
      async captureFailureEvidence() {
        return { diagnostics, screenshotPng: null };
      },
      async readFile() {
        return "{}";
      },
      async writeFile() {},
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    try {
      await assert.rejects(
        runVisionExperienceMain(
          ["--out", outPath, "--guest-input", guestInputPath],
          {
            startVisionOwner: () => undefined,
            createAdapter: () => adapter,
            runSlice: async () => {
              throw new Error("result-surface timed out");
            },
          },
        ),
        /result-surface timed out/,
      );
      const diagnosticsPath = join(
        root,
        "vision-experience-artifacts",
        "failure-diagnostics.json",
      );
      const serialized = readFileSync(diagnosticsPath);
      assert.ok(serialized.byteLength <= 2 * 1024 * 1024);
      const bounded = JSON.parse(serialized.toString("utf8"));
      assert.equal(bounded.diagnosticsTruncated, true);
      assert.equal(bounded.lastDomState.route, "#/try-on");
      assert.equal(bounded.vision.roles[0].pid, 42);
      assert.ok(bounded.machineRuntimeTrace.length > 0);
      assert.ok(bounded.cdp.console.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("从实际 guest-input 的 runtime bootstrap 派生 Service API 规范来源", () => {
    const sourceGarment = {
      publicPath:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 12,
      template: "tshirt_short_sleeve",
      width: 512,
      height: 640,
    };
    assert.deepEqual(
      sourceGarmentBindingFromGuestInput({
        schemaVersion: "vem-local-testbed-guest-input/v1",
        runtimeBootstrap: {
          provisioningApiBaseUrl: "http://10.0.0.15:26849/api",
        },
        visionAcceptance: {
          selectedCatalogKey: "product:550e8400-e29b-41d4-a716-446655440120",
          selectedVariantId: "550e8400-e29b-41d4-a716-446655440121",
          seededTryOnVariants: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440120",
              variantId: "550e8400-e29b-41d4-a716-446655440121",
              size: "M",
              garmentMediaAssetId: sourceGarment.assetId,
            },
          ],
          sourceGarment,
        },
      }),
      {
        selectedCatalogKey: "product:550e8400-e29b-41d4-a716-446655440120",
        selectedVariantId: "550e8400-e29b-41d4-a716-446655440121",
        selectedSize: "M",
        sourceGarmentMetadata: {
          ...sourceGarment,
          reference:
            "http://10.0.0.15:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
          origin: "http://10.0.0.15:26849",
        },
        sourceGarmentServiceApiOrigin: "http://10.0.0.15:26849",
      },
    );
  });

  it("selected variant seed 缺失、重复、错绑或 size 注入时 fail closed", () => {
    const sourceGarment = {
      ...sourceGarmentMetadataFixture,
      publicPath: new URL(sourceGarmentMetadataFixture.reference).pathname,
    };
    const selectedSeed = {
      productId: selectedCatalogKey.slice("product:".length),
      variantId: selectedVariantId,
      size: "M",
      garmentMediaAssetId: sourceGarment.assetId,
    };
    const parse = (seededTryOnVariants: unknown) =>
      sourceGarmentBindingFromGuestInput({
        runtimeBootstrap: {
          provisioningApiBaseUrl: "http://127.0.0.1:26849/api",
        },
        visionAcceptance: {
          selectedCatalogKey,
          selectedVariantId,
          seededTryOnVariants,
          sourceGarment,
        },
      });

    for (const invalid of [
      [],
      [selectedSeed, { ...selectedSeed }],
      [{ ...selectedSeed, productId: "550e8400-e29b-41d4-a716-446655440129" }],
      [
        {
          ...selectedSeed,
          garmentMediaAssetId: "550e8400-e29b-41d4-a716-446655440129",
        },
      ],
      [{ ...selectedSeed, size: 'M"] [data-test="try-on' }],
      [{ ...selectedSeed, size: "" }],
    ]) {
      assert.throws(() => parse(invalid), /vision acceptance binding/i);
    }
  });

  it("拒绝把 host loopback 的 source garment 带进 guest", () => {
    assert.throws(
      () =>
        sourceGarmentBindingFromGuestInput({
          runtimeBootstrap: {
            provisioningApiBaseUrl: "http://10.0.0.15:26849/api",
          },
          visionAcceptance: {
            sourceGarment: {
              publicPath:
                "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
            },
          },
        }),
      /vision acceptance binding/i,
    );
  });

  it("guest-input 缺失或注入式目录 identity 时 fail closed", () => {
    for (const visionAcceptance of [
      {},
      {
        selectedCatalogKey:
          'product:550e8400-e29b-41d4-a716-446655440120"] [data-test="try-on"',
        selectedVariantId: "550e8400-e29b-41d4-a716-446655440121",
      },
      {
        selectedCatalogKey: "product:550e8400-e29b-41d4-a716-446655440120",
        selectedVariantId: "not-a-uuid",
      },
    ]) {
      assert.throws(
        () =>
          sourceGarmentBindingFromGuestInput({
            runtimeBootstrap: {
              provisioningApiBaseUrl: "http://10.0.0.15:26849/api",
            },
            visionAcceptance,
          }),
        /vision acceptance binding/i,
      );
    }
  });

  it("从三次结果资源与同一 attempt 的 100/105 资源生成几何业务断言", async () => {
    const report = await runVisionExperienceSlice({
      adapter: fakeUiAdapter(),
      acceptanceBinding: visionAcceptanceBinding,
      includeGarmentScale: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const ids =
      report.businessSets[0].assertions?.map((assertion) => assertion.id) ?? [];
    assert.ok(ids.includes("result-sleeves-retained"));
    assert.ok(ids.includes("garment-scale-renders-pixels"));
    assert.equal(report.businessSets[0].status, "passed");
  });

  it("三段受控录播缺失时保留结构化 fail-closed 几何诊断", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "select-recorded-video-fixture") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "已安装产物未携带动态 far/mid/near 录播夹具",
        };
      }
      return originalRun(command, args);
    };
    const report = await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      includeGarmentScale: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const set = report.businessSets[0];
    assert.equal(set.status, "failed");
    assert.equal(
      set.assertions?.find(
        (assertion) => assertion.id === "result-automatic-scale",
      )?.status,
      "failed",
    );
    assert.deepEqual(set.supportingEvidence.at(-1), {
      kind: "vision-recorded-geometry-fixture",
      status: "blocked",
      reason: "已安装产物未携带动态 far/mid/near 录播夹具",
      segments: ["far"],
    });
  });

  it("录播夹具受阻时 fail closed、不会回退普通试衣，并在 finally 恢复默认录播", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "select-recorded-video-fixture") {
        return { exitCode: 1, stdout: "", stderr: "geometry fixture blocked" };
      }
      return originalRun(command, args);
    };

    const report = await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      includeGarmentScale: true,
      timeoutMs: 30,
      pollMs: 5,
    });
    assert.equal(report.businessSets[0].status, "failed");
    assert.equal(
      adapter.calls.some(
        (call) =>
          call.command === "click" && call.args[0] === '[data-test="try-on"]',
      ),
      false,
    );
    assert.deepEqual(adapter.calls.at(-1), {
      command: "restore-recorded-video-fixtures",
      args: [],
    });
  });

  it("恢复默认录播失败会成为独立 operational failure", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) =>
      command === "restore-recorded-video-fixtures"
        ? { exitCode: 1, stdout: "", stderr: "restore failed" }
        : originalRun(command, args);

    await assert.rejects(
      runVisionExperienceSlice({
        adapter,
        acceptanceBinding: visionAcceptanceBinding,
        includeGarmentScale: true,
        timeoutMs: 2_000,
        pollMs: 10,
      }),
      (error: any) =>
        error?.stage === "restore-recorded-video-fixtures" &&
        error?.message.includes("restore failed"),
    );
  });

  it("未选择 geometry 夹具的轨道不会触发默认录播重启", async () => {
    const adapter = fakeUiAdapter();
    await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(
      adapter.calls.some(
        (call) => call.command === "restore-recorded-video-fixtures",
      ),
      false,
    );
  });

  it("主 geometry verdict 与恢复失败同时存在时以保留报告的 operational failure 退出", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "select-recorded-video-fixture") {
        return { exitCode: 1, stdout: "", stderr: "geometry fixture blocked" };
      }
      if (command === "restore-recorded-video-fixtures") {
        return { exitCode: 1, stdout: "", stderr: "restore failed" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runVisionExperienceSlice({
        adapter,
        acceptanceBinding: visionAcceptanceBinding,
        includeGarmentScale: true,
        timeoutMs: 30,
        pollMs: 5,
      }),
      (error: any) =>
        error?.stage === "restore-recorded-video-fixtures" &&
        error?.report?.businessSets?.[0]?.status === "failed" &&
        error?.report?.businessSets?.[0]?.supportingEvidence?.at(-1)?.kind ===
          "vision-recorded-fixture-restore" &&
        error?.primaryFailure?.id === "result-sleeves-retained",
    );
  });

  it("非 Error 主失败也不会被默认录播恢复失败覆盖", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "select-recorded-video-fixture") {
        throw "fixture primary failed";
      }
      if (command === "restore-recorded-video-fixtures") {
        return { exitCode: 1, stdout: "", stderr: "restore failed" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runVisionExperienceSlice({
        adapter,
        acceptanceBinding: visionAcceptanceBinding,
        includeGarmentScale: true,
        timeoutMs: 30,
        pollMs: 5,
      }),
      (error: any) =>
        error?.stage === "vision-experience-primary" &&
        error?.primaryFailure === "fixture primary failed" &&
        error?.restoreFailure?.stage === "restore-recorded-video-fixtures",
    );
  });

  it("startGarment 错绑与录播恢复失败并存时仍上卷业务报告", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) =>
      command === "restore-recorded-video-fixtures"
        ? { exitCode: 1, stdout: "", stderr: "restore failed" }
        : originalRun(command, args);

    await assert.rejects(
      runVisionExperienceSlice({
        adapter,
        acceptanceBinding: {
          ...visionAcceptanceBinding,
          sourceGarmentMetadata: {
            ...sourceGarmentMetadataFixture,
            template: "tshirt_long_sleeve",
          },
        },
        includeGarmentScale: true,
        timeoutMs: 2_000,
        pollMs: 10,
      }),
      (error: any) =>
        error?.stage === "vision-experience-primary" &&
        error?.report?.businessSets?.[0]?.status === "failed" &&
        error?.evidence?.kind === "vision-start-garment-binding" &&
        error?.report?.businessSets?.[0]?.supportingEvidence?.at(-1)?.kind ===
          "vision-recorded-fixture-restore" &&
        error?.restoreFailure?.reason === "restore failed",
    );
  });

  it("produces a registry-validated passed report", async () => {
    const registry = createBusinessCheckRegistryV2([
      {
        name: "visionExperience",
        fullRequired: true,
        runner: { kind: "node", script: "vision-experience-runner.ts" },
        validator: (set) => ({
          ok: set.status === "passed",
          errors: set.status === "failed" ? ["vision assertions failed"] : [],
        }),
      },
    ]);
    const adapter = fakeUiAdapter();
    const report = await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      includeGarmentScale: true,
      includeDegradation: true,
      stopOwner: async () => {
        const current = JSON.parse(
          await adapter.readFile("ui/try-on-state.json"),
        );
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            ...current,
            tryOnPresent: false,
            buyDisabled: false,
          }),
        );
      },
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const result = registry.validateReport(report);
    assert.equal(result.businessSets.visionExperience.status, "passed");
    assert.equal(report.businessSets[0].assertionCount, 22);
  });

  it("waits for a stable Vision role PID set before starting the flow", async () => {
    let readyPolls = 0;
    let navigateCalls = 0;
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "navigate") navigateCalls += 1;
      if (command === "vision-ready") {
        readyPolls += 1;
        if (readyPolls <= 2) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({ ready: false, pids: [100 + readyPolls] }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ready: true, pids: [999, 1000] }),
          stderr: "",
        };
      }
      return originalRun(command, args);
    };
    const report = await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      includeGarmentScale: false,
      visionStabilityMs: 40,
      visionStabilityTimeoutMs: 2_000,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(report.businessSets[0].status, "passed");
    assert.equal(navigateCalls, 1);
    assert.ok(
      readyPolls >= 4,
      `expected multiple readiness polls, got ${readyPolls}`,
    );
  });

  it("失败探针的非 JSON 就绪输出不得被视为稳定", async () => {
    let polls = 0;
    const adapter = createFakeTestAdapter({
      commands: {
        "vision-ready": () => {
          polls += 1;
          return { exitCode: 1, stdout: "unreachable", stderr: "" };
        },
      },
    });
    await assert.rejects(
      waitForVisionStable(adapter, {
        timeoutMs: 30,
        stabilityMs: 5,
        pollMs: 5,
      }),
      /vision-stable did not become true/,
    );
    assert.ok(polls > 1);
  });

  it("covers manual capture and departure cancellation", async () => {
    const statePath = "ui/try-on-state.json";
    const attemptId = tryOnAttemptId;
    const capturedEvidence = capturedEvidenceFor(attemptId);
    let tryOnEntries = 0;
    const adapter = createFakeTestAdapter({
      files: {
        [statePath]: JSON.stringify({ route: "#/catalog", state: "idle" }),
      },
      commands: {
        "vision-ready": () => ({ exitCode: 0, stdout: "ready", stderr: "" }),
        "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        'click [data-test="catalog-category"][data-category-key="tshirts"]':
          async () => {
            await adapter.writeFile(
              statePath,
              JSON.stringify({ route: "#/catalog", state: "idle" }),
            );
            return { exitCode: 0, stdout: "ok", stderr: "" };
          },
        [`click ${selectedProductSelector}`]: async () => {
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              route: selectedProductRoute,
              catalogKey: selectedCatalogKey,
              variantId: selectedVariantId,
              state: "idle",
              tryOnPresent: true,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': async () => {
          tryOnEntries += 1;
          if (tryOnEntries === 1) {
            await adapter.writeFile(
              statePath,
              JSON.stringify({
                route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
                state: "acquiring",
                attemptId,
                preview: { naturalWidth: 720, naturalHeight: 1280 },
                startGarment: {
                  assetId: sourceGarmentMetadataFixture.assetId,
                  digest: sourceGarmentMetadataFixture.digest,
                  contentType: sourceGarmentMetadataFixture.contentType,
                  byteSize: sourceGarmentMetadataFixture.byteSize,
                  template: sourceGarmentMetadataFixture.template,
                },
              }),
            );
            setTimeout(() => {
              void adapter.writeFile(
                statePath,
                JSON.stringify({
                  route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
                  state: "completed",
                  attemptId,
                  preview: { naturalWidth: 720, naturalHeight: 1280 },
                  resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
                  observationTimeline: observationTimelineFor(attemptId),
                  startGarment: {
                    assetId: sourceGarmentMetadataFixture.assetId,
                    digest: sourceGarmentMetadataFixture.digest,
                    contentType: sourceGarmentMetadataFixture.contentType,
                    byteSize: sourceGarmentMetadataFixture.byteSize,
                    template: sourceGarmentMetadataFixture.template,
                  },
                  ...capturedEvidence,
                }),
              );
            }, 50);
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/try-on?catalogKey=product%3A1",
              state: "acquiring",
              manualCaptureAllowed: true,
              guidance: "请保持不动，3 秒后自动拍摄",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on-manual-capture"]': async () => {
          const current = JSON.parse(await adapter.readFile(statePath));
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              ...current,
              state: "completed",
              manualCaptureAllowed: false,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        "simulate-departure": async () => {
          const current = JSON.parse(await adapter.readFile(statePath));
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              ...current,
              state: "canceled",
              phaseText: "检测到顾客已离开，本次试衣已取消",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    });
    const report = await runVisionExperienceSlice({
      adapter,
      acceptanceBinding: visionAcceptanceBinding,
      includeManualCapture: true,
      includeDeparture: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(report.businessSets[0].status, "passed");
    assert.equal(report.businessSets[0].assertionCount, 16);
  });
});

describe("process replay 轨道集成", () => {
  const originalReplayEnv = process.env.VEM_PROCESS_REPLAY;
  const originalReplayDir = process.env.VEM_PROCESS_REPLAY_DIR;

  function withEnv(values, callback) {
    return async () => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        await callback();
      } finally {
        if (originalReplayEnv === undefined)
          delete process.env.VEM_PROCESS_REPLAY;
        else process.env.VEM_PROCESS_REPLAY = originalReplayEnv;
        if (originalReplayDir === undefined)
          delete process.env.VEM_PROCESS_REPLAY_DIR;
        else process.env.VEM_PROCESS_REPLAY_DIR = originalReplayDir;
      }
    };
  }

  it(
    "focused fast 显式开启时包装 slice 并把回放摘要写入 supportingEvidence",
    withEnv(
      { VEM_PROCESS_REPLAY: "1", VEM_PROCESS_REPLAY_DIR: "/tmp/replay" },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "vem-vision-replay-on-"));
        const outPath = join(root, "vision-experience.json");
        const guestInputPath = writeVisionGuestInput(root);
        const adapter = fakeUiAdapter() as any;
        adapter.endpoint = "http://127.0.0.1:9222";
        adapter.connect = async () => adapter;
        adapter.close = async () => {};
        adapter.recordMilestone = () => {};
        let capturedContext = null;
        try {
          await runVisionExperienceMain(
            [
              "--mode",
              "fast",
              "--out",
              outPath,
              "--guest-input",
              guestInputPath,
            ],
            {
              startVisionOwner: () => undefined,
              createAdapter: () => adapter,
              runSlice: async () => passedVisionReport(),
              runReplay: async (context, operation) => {
                capturedContext = context;
                const result = await operation();
                context.onSummary?.(replaySummaryFixture());
                return result;
              },
            },
          );
          assert.equal(capturedContext.businessSet, "visionExperience");
          assert.equal(capturedContext.outputDirectory, "/tmp/replay");
          assert.equal(capturedContext.endpoint, adapter.endpoint);
          const report = JSON.parse(readFileSync(outPath, "utf8"));
          const evidence = report.businessSets[0].supportingEvidence.find(
            (entry) => entry.kind === "business-set-process-replay",
          );
          assert.equal(evidence.summary.status, "completed");
          assert.equal(evidence.summary.framesWritten, 3);
          assert.equal(report.businessSets[0].status, "passed");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
  );

  it(
    "默认关闭：不包装 slice、不触碰回放环境",
    withEnv(
      { VEM_PROCESS_REPLAY: undefined, VEM_PROCESS_REPLAY_DIR: undefined },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "vem-vision-replay-off-"));
        const outPath = join(root, "vision-experience.json");
        const guestInputPath = writeVisionGuestInput(root);
        const adapter = fakeUiAdapter() as any;
        adapter.endpoint = "http://127.0.0.1:9222";
        adapter.connect = async () => adapter;
        adapter.close = async () => {};
        adapter.recordMilestone = () => {};
        let replayInvoked = false;
        try {
          await runVisionExperienceMain(
            [
              "--mode",
              "fast",
              "--out",
              outPath,
              "--guest-input",
              guestInputPath,
            ],
            {
              startVisionOwner: () => undefined,
              createAdapter: () => adapter,
              runSlice: async () => passedVisionReport(),
              runReplay: async () => {
                replayInvoked = true;
                return passedVisionReport();
              },
            },
          );
          assert.equal(replayInvoked, false);
          const report = JSON.parse(readFileSync(outPath, "utf8"));
          assert.equal(
            report.businessSets[0].supportingEvidence.some(
              (entry) => entry.kind === "business-set-process-replay",
            ),
            false,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
  );

  it(
    "业务抛错时回放摘要仍进入失败报告且原样抛出业务错误",
    withEnv(
      { VEM_PROCESS_REPLAY: "1", VEM_PROCESS_REPLAY_DIR: "/tmp/replay" },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "vem-vision-replay-fail-"));
        const outPath = join(root, "vision-experience.json");
        const guestInputPath = writeVisionGuestInput(root);
        const adapter = fakeUiAdapter() as any;
        adapter.endpoint = "http://127.0.0.1:9222";
        adapter.connect = async () => adapter;
        adapter.close = async () => {};
        adapter.recordMilestone = () => {};
        const businessError = new Error(
          "business failed inside replay",
        ) as Error & {
          report?: unknown;
        };
        businessError.report = passedVisionReport();
        try {
          await assert.rejects(
            runVisionExperienceMain(
              [
                "--mode",
                "fast",
                "--out",
                outPath,
                "--guest-input",
                guestInputPath,
              ],
              {
                startVisionOwner: () => undefined,
                createAdapter: () => adapter,
                runSlice: async () => {
                  throw businessError;
                },
                runReplay: async (context, operation) => {
                  try {
                    return await operation();
                  } catch (error) {
                    context.onSummary?.(
                      replaySummaryFixture({ status: "completed" }),
                    );
                    throw error;
                  }
                },
              },
            ),
            (error) => error === businessError,
          );
          const report = JSON.parse(readFileSync(outPath, "utf8"));
          const evidence = report.businessSets[0].supportingEvidence.find(
            (entry) => entry.kind === "business-set-process-replay",
          );
          assert.equal(evidence.summary.status, "completed");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
  );

  it(
    "把 guest-input 的 Vision mock 控制端口传给真实 CDP adapter",
    withEnv(
      { VEM_PROCESS_REPLAY: undefined, VEM_PROCESS_REPLAY_DIR: undefined },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "vem-vision-mock-port-"));
        const outPath = join(root, "vision-experience.json");
        const guestInputPath = writeVisionGuestInput(root);
        const input = JSON.parse(readFileSync(guestInputPath, "utf8"));
        input.hostControlPlane = { visionMockControlPort: 8123 };
        writeFileSync(guestInputPath, JSON.stringify(input));
        const adapter = fakeUiAdapter() as any;
        adapter.connect = async () => adapter;
        adapter.close = async () => {};
        adapter.recordMilestone = () => {};
        let adapterOptions = null;
        try {
          await runVisionExperienceMain(
            [
              "--mode",
              "fast",
              "--out",
              outPath,
              "--guest-input",
              guestInputPath,
            ],
            {
              startVisionOwner: () => undefined,
              createAdapter: (options) => {
                adapterOptions = options;
                return adapter;
              },
              runSlice: async () => passedVisionReport(),
            },
          );
          assert.equal(adapterOptions.visionMockControlPort, 8123);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
  );
});
