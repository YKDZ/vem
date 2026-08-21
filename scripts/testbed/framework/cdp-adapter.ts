import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import type {
  CapturedFrameFacts,
  CapturedFrameResource,
  VisionProtocolEvent,
} from "./slices/vision-experience/captured-source-evidence.ts";
import type { SemanticResultPng } from "./slices/vision-experience/result-geometry-evidence.ts";
import type { VisionExperienceObservation } from "./slices/vision-experience/vision-experience-driver.ts";
import type { CommandResult, TestAdapter } from "./test-adapter.ts";

import {
  visionV2AttemptAdjustMessageSchema,
  visionV2AttemptStartMessageSchema,
  visionV2CapturedFrameSchema,
  visionV2ResultAdjustedMessageSchema,
} from "../../../packages/shared/src/schemas/vision-v2.ts";
import { isStructurallyValidPng } from "../../lib/png-structure.mjs";
import {
  isSensitiveEvidenceKey,
  redactSensitiveEvidenceText,
} from "../failure-evidence-redaction.ts";
import { EVIDENCE_LIMITS } from "../full-workflow-evidence-manifest.ts";
import {
  CdpClient,
  activateVisibleSelector,
  captureScreenshot,
  enablePageRuntime,
  evaluateExpression,
  readMachineRuntimeTraceSnapshot,
  rewriteWebSocketDebuggerUrl,
} from "../machine-ui-cdp-driver.ts";
import {
  hasVisionOrigin,
  normalizeVisionOrigin,
} from "./slices/vision-experience/captured-source-evidence.ts";
import { decodeSemanticResultPng } from "./slices/vision-experience/result-geometry-evidence.ts";
import {
  parseSourceGarmentMetadata,
  type SourceGarmentMetadata,
} from "./slices/vision-experience/source-garment-evidence.ts";

const MAX_RESULT_PNG_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 128;
const MAX_DIAGNOSTIC_TEXT = 2_048;

function redactDiagnosticText(value: unknown): string {
  return redactSensitiveEvidenceText(value, MAX_DIAGNOSTIC_TEXT);
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return redactDiagnosticText(value);
  if (depth >= 6) return "[bounded]";
  if (Array.isArray(value)) {
    return value
      .slice(-MAX_DIAGNOSTIC_ENTRIES)
      .map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  if (typeof value !== "object") return redactDiagnosticText(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/^(?:headers?|requestBody|responseBody|body|authorization|cookie|set-cookie)$/i.test(
            key,
          ),
      )
      .slice(0, MAX_DIAGNOSTIC_ENTRIES)
      .map(([key, entry]) => [
        key,
        isSensitiveEvidenceKey(key)
          ? "[REDACTED]"
          : sanitizeDiagnosticValue(entry, depth + 1),
      ]),
  );
}

function diagnosticErrorTree(error: unknown, depth = 0): unknown {
  if (depth >= 4) return { message: "[bounded error cause]" };
  if (!(error instanceof Error)) {
    return { message: redactDiagnosticText(error) };
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  return sanitizeDiagnosticValue({
    name: error.name,
    message: error.message,
    stack: error.stack?.split("\n").slice(0, 12).join("\n") ?? null,
    cause: cause == null ? null : diagnosticErrorTree(cause, depth + 1),
  });
}

function boundedPush<T>(target: T[], value: T): void {
  target.push(value);
  if (target.length > MAX_DIAGNOSTIC_ENTRIES) {
    target.splice(0, target.length - MAX_DIAGNOSTIC_ENTRIES);
  }
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface RuntimeRole {
  name: string;
  pid: number | null;
  ready: boolean;
}

export function isControlledCapturedFrameReference(
  reference: unknown,
): reference is string {
  return (
    typeof reference === "string" &&
    visionV2CapturedFrameSchema.shape.reference.safeParse(reference).success
  );
}

function websocketHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:") return null;
    url.protocol = "http:";
    return normalizeVisionOrigin(url.origin);
  } catch {
    return null;
  }
}

type GeometrySegment = "far" | "mid" | "near";
const GEOMETRY_ENTRY = {
  far: "geometryFar",
  mid: "geometryMid",
  near: "geometryNear",
} as const;

/** 从安装 manifest 的规范 entry、文件名与摘要裁决录播选择。 */
export function validateRecordedVideoFixtureSelection({
  segment,
  mapping,
  manifest,
  actualDigest,
}: {
  segment: GeometrySegment;
  mapping: Record<GeometrySegment, unknown>;
  manifest: unknown;
  actualDigest: unknown;
}): { ok: true; file: string } | { ok: false; reason: string } {
  const entries = (["far", "mid", "near"] as const).map((key) => mapping[key]);
  if (
    !entries.every((entry) => typeof entry === "string") ||
    new Set(entries).size !== 3 ||
    entries.some((entry) => !/^geometry(?:Far|Mid|Near)$/.test(entry)) ||
    mapping[segment] !== GEOMETRY_ENTRY[segment]
  ) {
    return {
      ok: false,
      reason: "三段录播 entry 必须是互异的规范 geometry entry",
    };
  }
  const recordings = (
    manifest as { recordings?: Record<string, unknown> } | null
  )?.recordings;
  const candidates = (Object.values(GEOMETRY_ENTRY) as string[]).map(
    (entry) =>
      recordings?.[entry] as
        | {
            file?: unknown;
            sha256?: unknown;
            loop?: unknown;
            source?: unknown;
            sourceSha256?: unknown;
            generator?: unknown;
          }
        | undefined,
  );
  if (
    candidates.length !== 3 ||
    candidates.some(
      (recording) =>
        !recording ||
        typeof recording.file !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*[.]mp4$/.test(recording.file) ||
        !/^[a-f0-9]{64}$/.test(recording.sha256 as string) ||
        recording.loop !== true ||
        typeof recording.source !== "string" ||
        !/^[a-f0-9]{64}$/.test(recording.sourceSha256 as string) ||
        typeof recording.generator !== "string",
    ) ||
    new Set(candidates.map((recording) => recording!.file)).size !== 3 ||
    new Set(candidates.map((recording) => recording!.sha256)).size !== 3 ||
    new Set(candidates.map((recording) => recording!.source)).size !== 1 ||
    new Set(candidates.map((recording) => recording!.sourceSha256)).size !==
      1 ||
    new Set(candidates.map((recording) => recording!.generator)).size !== 1
  ) {
    return {
      ok: false,
      reason: "安装 manifest 缺少同源规范 geometry 三段 entry",
    };
  }
  const recording =
    candidates[
      (Object.keys(GEOMETRY_ENTRY) as GeometrySegment[]).indexOf(segment)
    ]!;
  if (actualDigest !== recording.sha256) {
    return { ok: false, reason: "安装录播文件摘要与 manifest 不匹配" };
  }
  return { ok: true, file: recording.file };
}

/**
 * 将 CDP 网络事件收敛为当前配置 Vision websocket 的有界 attempt timeline。
 * 任何其他 loopback 服务即使复用了 V2 envelope，也不能贡献试衣验收事实。
 */
export class VisionProtocolEvidenceCollector {
  readonly visionOrigin: string;
  private requestIds = new Set<string>();
  private events: VisionProtocolEvent[] = [];
  private startGarments = new Map<string, unknown[]>();
  private adjustmentScales = new Map<string, number[]>();
  private adjustedResults = new Map<string, unknown[]>();

  constructor(visionBaseUrl: string) {
    const visionOrigin = normalizeVisionOrigin(visionBaseUrl);
    if (!visionOrigin) {
      throw new Error("Vision base URL must be a loopback HTTP origin");
    }
    this.visionOrigin = visionOrigin;
  }

  observeWebSocketCreated(event: unknown): void {
    const value = event as { requestId?: unknown; url?: unknown } | null;
    if (
      typeof value?.requestId === "string" &&
      websocketHttpOrigin(value.url) === this.visionOrigin
    ) {
      this.requestIds.add(value.requestId);
    }
  }

  observeWebSocketClosed(event: unknown): void {
    const requestId = (event as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId === "string") this.requestIds.delete(requestId);
  }

  observeWebSocketFrameReceived(event: unknown): void {
    const value = event as {
      requestId?: unknown;
      response?: { payloadData?: unknown };
    } | null;
    if (
      typeof value?.requestId !== "string" ||
      !this.requestIds.has(value.requestId) ||
      typeof value.response?.payloadData !== "string"
    ) {
      return;
    }
    try {
      const adjusted = visionV2ResultAdjustedMessageSchema.safeParse(
        JSON.parse(value.response.payloadData),
      );
      if (adjusted.success) {
        const results =
          this.adjustedResults.get(adjusted.data.payload.attemptId) ?? [];
        results.push(structuredClone(adjusted.data.payload.result));
        this.adjustedResults.set(adjusted.data.payload.attemptId, results);
        return;
      }
      const message = JSON.parse(value.response.payloadData) as {
        protocol?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      const payload = message.payload as { attemptId?: unknown } | null;
      if (
        message.protocol !== "vem.vision.v2" ||
        typeof message.type !== "string" ||
        !/^vision[.]try_on[.]attempt[.](?:accepted|acquiring|captured|generating|completed|failed|canceled)$/.test(
          message.type,
        ) ||
        !payload ||
        typeof payload.attemptId !== "string"
      ) {
        return;
      }
      this.events.push({
        type: message.type,
        requestId: value.requestId,
        origin: this.visionOrigin,
        payload: structuredClone(payload) as VisionProtocolEvent["payload"],
      });
      if (this.events.length > 256) {
        this.events.splice(0, this.events.length - 256);
      }
    } catch {
      // 无关或损坏的 CDP frame 不得改变 acceptance evidence。
    }
  }

  /** 只记录当前 Vision websocket 上、通过公开 V2 schema 的实际 start 载荷。 */
  observeWebSocketFrameSent(event: unknown): void {
    const value = event as {
      requestId?: unknown;
      response?: { payloadData?: unknown };
    } | null;
    if (
      typeof value?.requestId !== "string" ||
      !this.requestIds.has(value.requestId) ||
      typeof value.response?.payloadData !== "string"
    ) {
      return;
    }
    try {
      const adjustment = visionV2AttemptAdjustMessageSchema.safeParse(
        JSON.parse(value.response.payloadData),
      );
      if (adjustment.success) {
        const scales =
          this.adjustmentScales.get(adjustment.data.payload.attemptId) ?? [];
        scales.push(adjustment.data.payload.garmentScale);
        this.adjustmentScales.set(adjustment.data.payload.attemptId, scales);
        return;
      }
      const parsed = visionV2AttemptStartMessageSchema.safeParse(
        JSON.parse(value.response.payloadData),
      );
      if (!parsed.success) return;
      const garments =
        this.startGarments.get(parsed.data.payload.attemptId) ?? [];
      garments.push(structuredClone(parsed.data.payload.garment));
      this.startGarments.set(parsed.data.payload.attemptId, garments);
      if (this.startGarments.size > 128) {
        this.startGarments.delete(this.startGarments.keys().next().value!);
      }
    } catch {
      // 无关或损坏的 CDP frame 不得改变 acceptance evidence。
    }
  }

  /** 重发或缺失 start 都不提供身份，避免把不唯一的 attempt 当作已绑定。 */
  startGarmentForAttempt(attemptId: string): unknown | null {
    const garments = this.startGarments.get(attemptId);
    return garments?.length === 1 ? (garments[0] ?? null) : null;
  }

  adjustmentForAttempt(attemptId: string): {
    scales: number[];
    results: unknown[];
  } {
    return {
      scales: [...(this.adjustmentScales.get(attemptId) ?? [])],
      results: structuredClone(this.adjustedResults.get(attemptId) ?? []),
    };
  }

  eventsForAttempt(attemptId: string): VisionProtocolEvent[] {
    return this.events.filter((event) => event.payload.attemptId === attemptId);
  }

  clear(): void {
    this.requestIds.clear();
    this.events = [];
    this.startGarments.clear();
    this.adjustmentScales.clear();
    this.adjustedResults.clear();
  }
}

/**
 * captured 资源按 attempt 与不可变 captured identity 隔离缓存，避免同 URL 在
 * 下一 attempt 被重用时把旧字节当成当前输入。
 */
export class CapturedFrameEvidenceCache {
  private entries = new Map<string, Promise<CapturedFrameResource | null>>();
  private fetchImpl: typeof fetch;

  constructor({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async read({
    attemptId,
    visionOrigin,
    captured,
  }: {
    attemptId: string;
    visionOrigin: string;
    captured: CapturedFrameFacts;
  }): Promise<CapturedFrameResource | null> {
    if (
      !isControlledCapturedFrameReference(captured.reference) ||
      !hasVisionOrigin(captured.reference, visionOrigin)
    ) {
      return null;
    }
    const key = [
      attemptId,
      visionOrigin,
      captured.reference,
      captured.digest,
      captured.frameId,
    ].join("\u0000");
    let entry = this.entries.get(key);
    if (!entry) {
      entry = inspectCapturedFrameResource({
        fetchImpl: this.fetchImpl,
        attemptId,
        visionOrigin,
        captured,
      });
      this.entries.set(key, entry);
    }
    return await entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

const STATE_EXPRESSION = `(() => {
  const view = document.querySelector("[data-test='try-on-view']");
  const preview = document.querySelector("[data-test='try-on-acquisition-preview']");
  const result = document.querySelector("[data-test='try-on-result-image']");
  const scale = document.querySelector("[data-test='try-on-scale-value']");
  const detail = document.querySelector("[data-test='product-detail-page']");
  const buy = document.querySelector("[data-test='product-buy']");
  const tryOn = document.querySelector("[data-test='try-on']");
  const guidance = document.querySelector("[data-test='try-on-guidance']");
  const manual = document.querySelector("[data-test='try-on-manual-capture']");
  const phase = document.querySelector("[data-test='try-on-phase']");
  const countdown = document.querySelector("[data-test='try-on-countdown']");
  const previewRect = preview?.getBoundingClientRect();
  return JSON.stringify({
    route: location.hash,
    state: view?.dataset?.state ?? null,
    attemptId: view?.dataset?.attemptId ?? null,
    preview: {
      naturalWidth: Number(preview?.naturalWidth ?? 0),
      naturalHeight: Number(preview?.naturalHeight ?? 0),
    },
    resultUrl: result?.getAttribute("src") ?? null,
    scaleValue: scale?.textContent?.trim() ?? null,
    tryOnPresent: detail
      ? Boolean(tryOn instanceof HTMLElement)
      : null,
    buyDisabled: buy instanceof HTMLButtonElement ? buy.disabled : null,
    guidance: view?.dataset?.state === "acquiring"
      ? guidance?.textContent?.trim() ?? null
      : null,
    phaseText: phase?.textContent?.trim() ?? null,
    manualCaptureAllowed:
      manual instanceof HTMLButtonElement ? manual.disabled === false : null,
    countdownText: countdown?.textContent?.trim() ?? null,
    previewVisible: Boolean(preview?.getClientRects().length),
    previewRect: previewRect && previewRect.width > 0 && previewRect.height > 0
      ? { x: previewRect.x, y: previewRect.y, width: previewRect.width, height: previewRect.height }
      : null,
  });
})()`;

/**
 * 将 CDP 截图字节作为跨源预览帧身份。它不读取 image canvas，因而 Vision 与
 * Machine UI 使用不同 loopback origin 时不会因 CORS taint 退化成空或常量 hash。
 */
export function hashPreviewScreenshot(data: unknown): string {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error("预览截图不是规范 base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    throw new Error("预览截图不是规范 base64");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 下载并解码受控 Vision 结果 PNG；URL 或 digest 本身绝不能充当像素断言。 */
export async function readResultPngResource({
  reference,
  visionOrigin,
  fetchImpl = fetch,
}: {
  reference: unknown;
  visionOrigin: string;
  fetchImpl?: typeof fetch;
}): Promise<SemanticResultPng | null> {
  if (
    typeof reference !== "string" ||
    !hasVisionOrigin(reference, visionOrigin)
  )
    return null;
  try {
    const response = await fetchImpl(reference);
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      (declaredLength < 1 || declaredLength > MAX_RESULT_PNG_BYTES)
    ) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.ok ||
      response.status !== 200 ||
      response.url !== reference ||
      response.headers.get("content-type")?.split(";", 1)[0] !== "image/png" ||
      bytes.byteLength > MAX_RESULT_PNG_BYTES
    ) {
      return null;
    }
    return decodeSemanticResultPng(bytes);
  } catch {
    return null;
  }
}

/** 下载 guest-input 绑定的上传成衣源图；摘要、尺寸和无重定向缺一不可。 */
export async function readSourceGarmentPngResource({
  metadata,
  serviceApiOrigin,
  fetchImpl = fetch,
}: {
  metadata: unknown;
  serviceApiOrigin: unknown;
  fetchImpl?: typeof fetch;
}): Promise<SemanticResultPng | null> {
  const value = parseSourceGarmentMetadata(metadata, serviceApiOrigin);
  if (!value) return null;
  try {
    const response = await fetchImpl(value.reference);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.ok ||
      response.status !== 200 ||
      response.url !== value.reference ||
      response.headers.get("content-type")?.split(";", 1)[0] !== "image/png" ||
      bytes.byteLength > MAX_RESULT_PNG_BYTES ||
      bytes.byteLength !== value.byteSize ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        value.digest
    )
      return null;
    const decoded = decodeSemanticResultPng(bytes);
    return decoded.width === value.width && decoded.height === value.height
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/**
 * 真实 VM 适配器：把 CDP 页面状态读取与触摸点击映射为 testAdapter 接口。
 * 与本地 fake 实现同一契约，visionExperience 切片代码无需区分环境。
 */
export class CdpTestAdapter implements TestAdapter {
  endpoint: string;
  visionBaseUrl: string;
  client: CdpClient | null = null;
  protocolEvidence: VisionProtocolEvidenceCollector;
  capturedFrameResources = new CapturedFrameEvidenceCache();
  tryOnObservations: VisionExperienceObservation[] = [];
  sourceGarmentMetadata: unknown;
  sourceGarmentServiceApiOrigin: unknown;
  sourceGarmentPng: Promise<SemanticResultPng | null> | null = null;
  stopTryOnProtocolObserver: (() => void) | null = null;
  selectRecordedVideoFixtureImpl: typeof selectRecordedVideoFixture;
  diagnosticMilestones: unknown[] = [];
  stateObservations: unknown[] = [];
  consoleDiagnostics: unknown[] = [];
  exceptionDiagnostics: unknown[] = [];
  networkDiagnostics: unknown[] = [];
  lastDomState: Record<string, unknown> | null = null;

  constructor({
    endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:19222",
    visionBaseUrl = process.env.VISION_BASE_URL ?? "http://127.0.0.1:27892",
    sourceGarmentMetadata = null,
    sourceGarmentServiceApiOrigin = null,
    selectRecordedVideoFixtureImpl = selectRecordedVideoFixture,
  }: {
    endpoint?: string;
    visionBaseUrl?: string;
    sourceGarmentMetadata?: unknown;
    sourceGarmentServiceApiOrigin?: unknown;
    selectRecordedVideoFixtureImpl?: typeof selectRecordedVideoFixture;
  } = {}) {
    this.endpoint = endpoint;
    this.visionBaseUrl = visionBaseUrl;
    this.protocolEvidence = new VisionProtocolEvidenceCollector(visionBaseUrl);
    this.sourceGarmentMetadata = sourceGarmentMetadata;
    this.sourceGarmentServiceApiOrigin = sourceGarmentServiceApiOrigin;
    this.selectRecordedVideoFixtureImpl = selectRecordedVideoFixtureImpl;
  }

  recordMilestone(
    stage: string,
    status: "started" | "completed" | "failed",
    detail: unknown = null,
  ): void {
    boundedPush(
      this.diagnosticMilestones,
      sanitizeDiagnosticValue({
        at: new Date().toISOString(),
        stage,
        status,
        detail,
      }),
    );
  }

  observeDiagnosticEvent(method: string, event: unknown): void {
    const value = event as Record<string, any> | null;
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(value?.args)
        ? value.args.slice(0, 16).map((argument: Record<string, unknown>) => {
            const raw =
              argument?.value ?? argument?.description ?? argument?.type;
            const text = String(raw ?? "").trim();
            if (text.startsWith("{") || text.startsWith("[")) {
              return "[structured console payload omitted]";
            }
            return redactDiagnosticText(text);
          })
        : [];
      boundedPush(
        this.consoleDiagnostics,
        sanitizeDiagnosticValue({
          at: new Date().toISOString(),
          type: value?.type ?? null,
          args,
        }),
      );
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      boundedPush(
        this.exceptionDiagnostics,
        sanitizeDiagnosticValue({
          at: new Date().toISOString(),
          text: value?.exceptionDetails?.text ?? null,
          description: value?.exceptionDetails?.exception?.description ?? null,
          url: value?.exceptionDetails?.url ?? null,
          lineNumber: value?.exceptionDetails?.lineNumber ?? null,
          columnNumber: value?.exceptionDetails?.columnNumber ?? null,
        }),
      );
      return;
    }
    if (method === "Network.loadingFailed") {
      boundedPush(
        this.networkDiagnostics,
        sanitizeDiagnosticValue({
          at: new Date().toISOString(),
          kind: "loadingFailed",
          requestId: value?.requestId ?? null,
          resourceType: value?.type ?? null,
          errorText: value?.errorText ?? null,
          canceled: value?.canceled ?? false,
        }),
      );
      return;
    }
    if (
      method === "Network.responseReceived" &&
      Number(value?.response?.status) >= 400
    ) {
      boundedPush(
        this.networkDiagnostics,
        sanitizeDiagnosticValue({
          at: new Date().toISOString(),
          kind: "httpError",
          requestId: value?.requestId ?? null,
          resourceType: value?.type ?? null,
          url: value?.response?.url ?? null,
          status: value?.response?.status ?? null,
          statusText: value?.response?.statusText ?? null,
          mimeType: value?.response?.mimeType ?? null,
        }),
      );
    }
  }

  async connect({
    timeoutMs = 15_000,
  }: { timeoutMs?: number } = {}): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    let target: CdpTarget | undefined;
    while (Date.now() < deadline && !target) {
      const targets = (await (
        await fetch(`${this.endpoint}/json`)
      ).json()) as CdpTarget[];
      target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url.includes("tauri.localhost"),
      );
      if (!target) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (!target) {
      throw new Error("Machine UI CDP target was not found");
    }
    this.client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, this.endpoint),
    );
    await this.client.connect({ timeoutMs });
    await enablePageRuntime(this.client);
    await this.client.send("Network.enable");
    const stopCreated = this.client.on(
      "Network.webSocketCreated",
      (event: unknown) => this.protocolEvidence.observeWebSocketCreated(event),
    );
    const stopReceived = this.client.on(
      "Network.webSocketFrameReceived",
      (event: unknown) =>
        this.protocolEvidence.observeWebSocketFrameReceived(event),
    );
    const stopSent = this.client.on(
      "Network.webSocketFrameSent",
      (event: unknown) =>
        this.protocolEvidence.observeWebSocketFrameSent(event),
    );
    const stopClosed = this.client.on(
      "Network.webSocketClosed",
      (event: unknown) => this.protocolEvidence.observeWebSocketClosed(event),
    );
    const stopConsole = this.client.on("Runtime.consoleAPICalled", (event) =>
      this.observeDiagnosticEvent("Runtime.consoleAPICalled", event),
    );
    const stopException = this.client.on("Runtime.exceptionThrown", (event) =>
      this.observeDiagnosticEvent("Runtime.exceptionThrown", event),
    );
    const stopResponse = this.client.on("Network.responseReceived", (event) =>
      this.observeDiagnosticEvent("Network.responseReceived", event),
    );
    const stopLoadingFailed = this.client.on("Network.loadingFailed", (event) =>
      this.observeDiagnosticEvent("Network.loadingFailed", event),
    );
    this.stopTryOnProtocolObserver = () => {
      stopCreated();
      stopReceived();
      stopSent();
      stopClosed();
      stopConsole();
      stopException();
      stopResponse();
      stopLoadingFailed();
    };
    return this;
  }

  async readFile(path: string): Promise<string> {
    if (path !== "ui/try-on-state.json") {
      throw new Error(`unknown adapter file: ${path}`);
    }
    const state = JSON.parse(
      await evaluateExpression(this.client!, STATE_EXPRESSION),
    ) as { attemptId?: string | null };
    this.recordStateObservation(state as Record<string, unknown>);
    const previewFrameHash = await this.capturePreviewFrameHash(state);
    const protocolTimeline =
      typeof state.attemptId === "string"
        ? this.protocolEvidence.eventsForAttempt(state.attemptId)
        : [];
    const captured = protocolTimeline.find(
      (event) => event.type === "vision.try_on.attempt.captured",
    )?.payload.captured;
    const parsedCaptured = visionV2CapturedFrameSchema.safeParse(captured);
    const capturedResource =
      typeof state.attemptId === "string" && parsedCaptured.success
        ? await this.capturedFrameResources.read({
            attemptId: state.attemptId,
            visionOrigin: this.protocolEvidence.visionOrigin,
            captured: parsedCaptured.data,
          })
        : null;
    const resultPng = await readResultPngResource({
      reference: (state as { resultUrl?: unknown }).resultUrl,
      visionOrigin: this.protocolEvidence.visionOrigin,
    });
    this.sourceGarmentPng ??= readSourceGarmentPngResource({
      metadata: this.sourceGarmentMetadata,
      serviceApiOrigin: this.sourceGarmentServiceApiOrigin,
    });
    const countdownText =
      typeof (state as { countdownText?: unknown }).countdownText ===
        "string" &&
      ["3", "2", "1"].includes(
        (state as { countdownText: string }).countdownText,
      )
        ? (state as { countdownText: string }).countdownText
        : null;
    if (typeof state.attemptId === "string") {
      const latestAcquiring = [...protocolTimeline]
        .reverse()
        .find((event) => event.type === "vision.try_on.attempt.acquiring");
      this.tryOnObservations.push({
        atMs: Date.now(),
        attemptId: state.attemptId,
        state: (state as { state?: string | null }).state ?? null,
        holdRemainingMs:
          typeof latestAcquiring?.payload.holdRemainingMs === "number"
            ? latestAcquiring.payload.holdRemainingMs
            : null,
        countdownText,
        previewVisible:
          (state as { previewVisible?: unknown }).previewVisible === true,
        previewFrameHash: previewFrameHash,
        capturedFrameId:
          typeof captured?.frameId === "string" ? captured.frameId : null,
        capturedDigest:
          typeof captured?.digest === "string" ? captured.digest : null,
      });
      if (this.tryOnObservations.length > 512) {
        this.tryOnObservations.splice(0, this.tryOnObservations.length - 512);
      }
    }
    return JSON.stringify({
      ...state,
      visionOrigin: this.protocolEvidence.visionOrigin,
      protocolTimeline,
      capturedResource,
      resultPng,
      sourceGarmentPng: await this.sourceGarmentPng,
      sourceGarmentMetadata: parseSourceGarmentMetadata(
        this.sourceGarmentMetadata,
        this.sourceGarmentServiceApiOrigin,
      ),
      startGarment:
        typeof state.attemptId === "string"
          ? this.protocolEvidence.startGarmentForAttempt(state.attemptId)
          : null,
      adjustmentEvidence:
        typeof state.attemptId === "string"
          ? this.protocolEvidence.adjustmentForAttempt(state.attemptId)
          : null,
      observationTimeline: this.tryOnObservations.filter(
        (sample) => sample.attemptId === state.attemptId,
      ),
    });
  }

  private async capturePreviewFrameHash(
    state: unknown,
  ): Promise<string | null> {
    const preview =
      (state as { previewVisible?: unknown; previewRect?: unknown }) ?? {};
    const rect = preview.previewRect as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    } | null;
    if (
      preview.previewVisible !== true ||
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) ||
      (rect.width as number) <= 0 ||
      (rect.height as number) <= 0
    ) {
      return null;
    }
    const screenshot = await this.client!.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: Math.min(1, 16 / Math.max(rect.width, rect.height)),
      },
    });
    return hashPreviewScreenshot(screenshot.data);
  }

  async writeFile(): Promise<never> {
    throw new Error("CDP adapter does not support remote file writes");
  }

  private recordStateObservation(state: Record<string, unknown>): void {
    const observation = sanitizeDiagnosticValue({
      at: new Date().toISOString(),
      route: state?.route ?? null,
      state: state?.state ?? null,
      attemptId: state?.attemptId ?? null,
      countdownText: state?.countdownText ?? null,
      previewVisible: state?.previewVisible ?? false,
      preview: state?.preview ?? null,
      resultPresent:
        typeof state?.resultUrl === "string" && state.resultUrl.length > 0,
    }) as Record<string, unknown>;
    this.lastDomState = observation;
    boundedPush(this.stateObservations, observation);
  }

  async run(command: string, args: string[] = []): Promise<CommandResult> {
    this.recordMilestone(`adapter:${command}`, "started", { args });
    try {
      const result = await this.executeCommand(command, args);
      this.recordMilestone(
        `adapter:${command}`,
        result.exitCode === 0 ? "completed" : "failed",
        {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      );
      return result;
    } catch (error) {
      this.recordMilestone(`adapter:${command}`, "failed", {
        error: diagnosticErrorTree(error),
      });
      throw error;
    }
  }

  private async executeCommand(
    command: string,
    args: string[] = [],
  ): Promise<CommandResult> {
    if (command === "navigate") {
      const hash = args[0];
      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error("navigate requires a hash argument");
      }
      await evaluateExpression(
        this.client!,
        `location.hash = ${JSON.stringify(hash)}; true`,
      );
      return { exitCode: 0, stdout: "navigated", stderr: "" };
    }
    if (command === "click") {
      const selector = args[0];
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("click requires a selector argument");
      }
      await activateVisibleSelector(this.client!, selector, {
        kind: "mouse",
        timeoutMs: 15_000,
        pollMs: 100,
      });
      return { exitCode: 0, stdout: "clicked", stderr: "" };
    }
    if (command === "select-recorded-video-fixture") {
      const segment = args[0];
      if (segment !== "far" && segment !== "mid" && segment !== "near") {
        throw new Error(
          "recorded video fixture segment must be far, mid, or near",
        );
      }
      return this.selectRecordedVideoFixtureImpl(segment);
    }
    if (command === "stop-vision-role") {
      const roleIndex = args.indexOf("--role");
      const role = roleIndex >= 0 ? args[roleIndex + 1] : args[0];
      if (typeof role !== "string" || role.length === 0) {
        throw new Error("stop-vision-role requires a role argument");
      }
      const response = await fetch(
        `${this.visionBaseUrl}/v2/runtime/roles/${encodeURIComponent(role)}/stop`,
        { method: "POST" },
      );
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      return { exitCode: 0, stdout: "stopped", stderr: "" };
    }
    if (command === "probe-vision-role") {
      const role = args[0];
      const response = await fetch(`${this.visionBaseUrl}/v2/runtime/roles`);
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      const payload = (await response.json()) as { roles?: RuntimeRole[] };
      const declared = (payload.roles ?? []).find(
        (entry) => entry.name === role,
      );
      const dead =
        !declared || declared.pid === null || declared.ready === false;
      return {
        exitCode: dead ? 0 : 1,
        stdout: dead ? "dead" : "alive",
        stderr: "",
      };
    }
    if (command === "vision-ready") {
      let response;
      try {
        response = await fetch(`${this.visionBaseUrl}/v2/runtime/roles`);
      } catch {
        return { exitCode: 1, stdout: "unreachable", stderr: "" };
      }
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      const payload = (await response.json()) as { roles?: RuntimeRole[] };
      const roles = payload.roles ?? [];
      const ready =
        roles.length > 0 &&
        roles.every(
          (entry) =>
            entry?.ready === true &&
            Number.isInteger(entry?.pid) &&
            entry.pid! > 0,
        );
      const pids = roles
        .filter((entry) => Number.isInteger(entry?.pid) && entry.pid! > 0)
        .map((entry) => entry.pid);
      return {
        exitCode: ready ? 0 : 1,
        stdout: JSON.stringify({ ready, pids }),
        stderr: "",
      };
    }
    throw new Error(`CDP adapter does not implement command: ${command}`);
  }

  async captureFailureEvidence(error: unknown): Promise<{
    diagnostics: Record<string, any>;
    screenshotPng: Buffer | null;
  }> {
    this.recordMilestone("failure", "failed", {
      error: diagnosticErrorTree(error),
    });
    if (this.client) {
      try {
        const state = JSON.parse(
          await evaluateExpression(this.client, STATE_EXPRESSION, {
            timeoutMs: 2_000,
          }),
        ) as Record<string, unknown>;
        this.recordStateObservation(state);
      } catch (captureError) {
        this.recordMilestone("failure-dom-state", "failed", {
          error: diagnosticErrorTree(captureError),
        });
      }
    }

    let machineRuntimeTraceSnapshot: unknown = null;
    if (this.client) {
      try {
        machineRuntimeTraceSnapshot = sanitizeDiagnosticValue(
          await readMachineRuntimeTraceSnapshot(this.client, {
            timeoutMs: 2_000,
          }),
        );
      } catch (captureError) {
        this.recordMilestone("failure-runtime-trace", "failed", {
          error: diagnosticErrorTree(captureError),
        });
      }
    }

    const listener = {
      origin: this.visionBaseUrl,
      reachable: false,
      httpStatus: null as number | null,
      error: null as string | null,
    };
    let roles: unknown[] = [];
    try {
      const response = await fetch(`${this.visionBaseUrl}/v2/runtime/roles`, {
        signal: AbortSignal.timeout(2_000),
      });
      listener.reachable = true;
      listener.httpStatus = response.status;
      if (response.ok) {
        const payload = (await response.json()) as { roles?: unknown[] };
        roles = (Array.isArray(payload?.roles) ? payload.roles : [])
          .slice(0, 32)
          .map((entry) => {
            const role = entry as Record<string, unknown>;
            return {
              name: typeof role?.name === "string" ? role.name : null,
              pid: Number.isInteger(role?.pid) ? role.pid : null,
              ready: role?.ready === true,
            };
          });
      }
    } catch (captureError) {
      listener.error = redactDiagnosticText(
        captureError instanceof Error ? captureError.message : captureError,
      );
    }

    let screenshotPng: Buffer | null = null;
    if (this.client) {
      try {
        await captureScreenshot(this.client, {
          format: "png",
          timeoutMs: 5_000,
          label: "vision-experience-failure",
          maxBytes: EVIDENCE_LIMITS.screenshotPerFileBytes,
          screenshotSink: async ({ bytes }) => {
            screenshotPng = Buffer.from(bytes);
            return { ref: "memory://vision-experience-failure.png" };
          },
        });
      } catch (captureError) {
        this.recordMilestone("failure-screenshot", "failed", {
          error: diagnosticErrorTree(captureError),
        });
      }
    }

    const traceEntries = Array.isArray(
      (machineRuntimeTraceSnapshot as Record<string, unknown> | null)?.entries,
    )
      ? (machineRuntimeTraceSnapshot as { entries: unknown[] }).entries
      : [];
    return {
      diagnostics: sanitizeDiagnosticValue({
        schemaVersion: "vem-vision-experience-failure-diagnostics/v1",
        capturedAt: new Date().toISOString(),
        error: diagnosticErrorTree(error),
        milestones: this.diagnosticMilestones,
        stateObservations: this.stateObservations,
        lastDomState: this.lastDomState,
        machineRuntimeTraceSnapshot,
        machineRuntimeTrace: traceEntries,
        cdp: {
          console: this.consoleDiagnostics,
          exceptions: this.exceptionDiagnostics,
          networkErrors: this.networkDiagnostics,
        },
        vision: { listener, roles },
        fixtureRestarts: this.diagnosticMilestones.filter(
          (entry: any) =>
            entry?.stage === "adapter:select-recorded-video-fixture",
        ),
      }) as Record<string, any>,
      screenshotPng,
    };
  }

  async close(): Promise<void> {
    this.stopTryOnProtocolObserver?.();
    this.stopTryOnProtocolObserver = null;
    this.protocolEvidence.clear();
    this.capturedFrameResources.clear();
    this.tryOnObservations = [];
    this.diagnosticMilestones = [];
    this.stateObservations = [];
    this.consoleDiagnostics = [];
    this.exceptionDiagnostics = [];
    this.networkDiagnostics = [];
    this.lastDomState = null;
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

/**
 * 仅由 testbed 环境提供三段录播文件名，原子替换 site config 后重启同一安装 owner。
 * 产品协议与业务代码不接受该命令；候选未携带三段夹具时以非零结果 fail closed。
 */
export function selectRecordedVideoFixture(
  segment: "far" | "mid" | "near",
): CommandResult {
  const entry = GEOMETRY_ENTRY[segment];
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$entry = '${entry}'
$configPath = 'C:\ProgramData\VEM\vision\site.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($null -eq $config.cameras -or $null -eq $config.cameras.front) { throw 'Vision site config has no front camera' }
$activeVideoPath = [string]$config.cameras.front.video_path
if (-not [IO.Path]::IsPathFullyQualified($activeVideoPath)) { throw 'Vision site config front video is not an installed fixture path' }
$recordedRoot = Split-Path -Parent $activeVideoPath
$manifestPath = Join-Path $recordedRoot 'expected-results.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw '安装 recorded-video manifest 缺失' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$entries = @($manifest.recordings.geometryFar, $manifest.recordings.geometryMid, $manifest.recordings.geometryNear)
if ($entries.Count -ne 3 -or @($entries | Where-Object { $null -eq $_ -or $_.loop -ne $true -or [string]$_.file -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$' -or [string]$_.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]$_.sourceSha256 -notmatch '^[a-f0-9]{64}$' -or [string]::IsNullOrWhiteSpace([string]$_.source) -or [string]::IsNullOrWhiteSpace([string]$_.generator) }).Count -ne 0 -or @($entries.file | Select-Object -Unique).Count -ne 3 -or @($entries.sha256 | Select-Object -Unique).Count -ne 3 -or @($entries.source | Select-Object -Unique).Count -ne 1 -or @($entries.sourceSha256 | Select-Object -Unique).Count -ne 1 -or @($entries.generator | Select-Object -Unique).Count -ne 1) { throw '安装 manifest 缺少同源规范 geometry 三段 entry' }
$recording = $manifest.recordings.$entry
$filename = [string]$recording.file
$videoPath = Join-Path $recordedRoot $filename
if (-not (Test-Path -LiteralPath $videoPath -PathType Leaf)) { throw "安装录播文件缺失: $filename" }
$actualDigest = (Get-FileHash -LiteralPath $videoPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualDigest -cne [string]$recording.sha256) { throw "安装录播文件摘要不匹配: $filename" }
$config.cameras.front.source = 'recorded_video'
$config.cameras.front.role = 'profile_try_on'
$config.cameras.front.video_path = $videoPath
$config.cameras.front.loop = $true
$tempPath = "$configPath.$PID.tmp"
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempPath -Encoding utf8 -NoNewline
Move-Item -LiteralPath $tempPath -Destination $configPath -Force
$rolesUri = 'http://127.0.0.1:7892/v2/runtime/roles'
$visionModule = Import-Module (Join-Path (Get-Location) 'scripts\windows\vision-main-artifacts.psm1') -Force -PassThru
if ($null -eq $visionModule) { throw '安装 Vision canonical owner helper 缺失' }
function Get-CanonicalVisionOwner {
  return & $visionModule {
    Get-VisionMainCanonicalProcessBinding 'C:\VEM\vision\app' 'C:\ProgramData\VEM\vision\site.json'
  }
}
try { $before = Invoke-RestMethod -Uri $rolesUri -TimeoutSec 2 } catch { throw '切换前 Vision runtime 未就绪' }
if (@($before.roles).Count -eq 0 -or @($before.roles | Where-Object { $_.ready -ne $true -or $null -eq $_.pid }).Count -ne 0) { throw '切换前 Vision runtime 角色未全部 ready' }
$oldOwner = Get-CanonicalVisionOwner
if ($null -eq $oldOwner) { throw '切换前缺少唯一 canonical Vision owner' }
$oldMainPid = [int]$oldOwner.mainProcess.ProcessId
$oldCanonicalPids = @($oldOwner.canonicalProcesses | ForEach-Object { [int]$_.ProcessId })
Stop-ScheduledTask -TaskName 'VEMVisionRuntime' -ErrorAction SilentlyContinue
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  try { $afterStop = Invoke-RestMethod -Uri $rolesUri -TimeoutSec 2; $rolesStopped = $false } catch { $rolesStopped = $true }
  $remainingOldPids = @($oldCanonicalPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  $oldOwnerExited = $rolesStopped -and $remainingOldPids.Count -eq 0 -and $null -eq (Get-CanonicalVisionOwner)
  if ($oldOwnerExited) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $oldOwnerExited) { throw '停止后旧 Vision owner 仍提供 runtime 角色端点' }
Start-ScheduledTask -TaskName 'VEMVisionRuntime' -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$stableRoleSignature = $null
$stableSince = $null
do {
  try { $roles = Invoke-RestMethod -Uri $rolesUri -TimeoutSec 2 } catch { $roles = $null }
  $ready = $null -ne $roles -and @($roles.roles).Count -gt 0 -and @($roles.roles | Where-Object { $_.ready -ne $true -or $null -eq $_.pid }).Count -eq 0
  $task = Get-ScheduledTask -TaskName 'VEMVisionRuntime' -ErrorAction SilentlyContinue
  $owner = Get-CanonicalVisionOwner
  $singleOwner = $null -ne $task -and [string]$task.TaskName -eq 'VEMVisionRuntime' -and [string]$task.State -eq 'Running' -and $null -ne $owner
  $newCanonicalPids = if ($null -ne $owner) { @($owner.canonicalProcesses | ForEach-Object { [int]$_.ProcessId }) } else { @() }
  $rolesBelongToNewOwner = $ready -and $null -ne $owner -and [int]$owner.mainProcess.ProcessId -ne $oldMainPid -and @($roles.roles | ForEach-Object { [int]$_.pid } | Where-Object { $newCanonicalPids -notcontains $_ }).Count -eq 0
  $signature = if ($ready) { (@($roles.roles | Sort-Object name | ForEach-Object { "$($_.name):$($_.pid)" }) -join '|') } else { $null }
  if ($signature -ne $stableRoleSignature) { $stableRoleSignature = $signature; $stableSince = [DateTime]::UtcNow }
  if ($singleOwner -and $rolesBelongToNewOwner -and $null -ne $stableSince -and ([DateTime]::UtcNow - $stableSince).TotalMilliseconds -ge 1000) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $singleOwner -or -not $rolesBelongToNewOwner -or $null -eq $stableSince) { throw '新 VEMVisionRuntime owner 未以唯一稳定 roles/PID ready 状态启动' }
[Console]::Out.WriteLine($filename)
`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function inspectCapturedFrameResource({
  fetchImpl,
  attemptId,
  visionOrigin,
  captured,
}: {
  fetchImpl: typeof fetch;
  attemptId: string;
  visionOrigin: string;
  captured: CapturedFrameFacts;
}): Promise<CapturedFrameResource | null> {
  try {
    const response = await fetchImpl(captured.reference);
    const bytes = Buffer.from(await response.arrayBuffer());
    const dimensions = pngDimensions(bytes);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (
      !response.ok ||
      response.status !== 200 ||
      response.url !== captured.reference ||
      contentType !== "image/png" ||
      !dimensions
    ) {
      return null;
    }
    return {
      attemptId,
      capturedDigest: captured.digest,
      capturedFrameId: captured.frameId,
      visionOrigin,
      reference: captured.reference,
      finalUrl: response.url,
      ok: true,
      httpStatus: 200,
      contentType: "image/png",
      byteSize: bytes.byteLength,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch {
    return null;
  }
}

function pngDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (!isStructurallyValidPng(bytes)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
