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
const MAX_NETWORK_REQUESTS = 128;
const MAX_DIAGNOSTIC_TEXT = 2_048;
const SAFE_DIAGNOSTIC_PATH_SEGMENTS = new Set([
  "api",
  "assets",
  "content",
  "images",
  "media-assets",
  "results",
  "try-on",
  "v2",
]);
const SAFE_DIAGNOSTIC_IMAGE_EXTENSIONS = new Set([
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

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

interface NetworkRequestDiagnostic {
  url: string | null;
  resourceType: string | null;
  responseStatus: number | null;
  responseMimeType: string | null;
  extraInfoStatus: number | null;
  extraInfoMimeType: string | null;
  responseObserved: boolean;
  responseEvidenceRecorded: boolean;
}

function emptyNetworkRequestDiagnostic(): NetworkRequestDiagnostic {
  return {
    url: null,
    resourceType: null,
    responseStatus: null,
    responseMimeType: null,
    extraInfoStatus: null,
    extraInfoMimeType: null,
    responseObserved: false,
    responseEvidenceRecorded: false,
  };
}

function correlatedNetworkStatus(
  request: NetworkRequestDiagnostic,
): number | null {
  return request.extraInfoStatus ?? request.responseStatus;
}

function correlatedNetworkMimeType(
  request: NetworkRequestDiagnostic,
): string | null {
  return request.extraInfoMimeType ?? request.responseMimeType;
}

function safeDiagnosticUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!url.protocol || !url.host) return null;
    const pathname = url.pathname
      .split("/")
      .map((segment) => {
        if (segment === "") return "";
        let decodedSegment = segment;
        try {
          decodedSegment = decodeURIComponent(segment);
        } catch {
          return "[REDACTED]";
        }
        const normalized = decodedSegment.toLowerCase();
        if (SAFE_DIAGNOSTIC_PATH_SEGMENTS.has(normalized)) return normalized;
        const extension = /[.]([a-z0-9]+)$/i
          .exec(decodedSegment)?.[1]
          ?.toLowerCase();
        return extension && SAFE_DIAGNOSTIC_IMAGE_EXTENSIONS.has(extension)
          ? `[REDACTED].${extension}`
          : "[REDACTED]";
      })
      .join("/");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

function networkStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function networkMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mimeType = value.split(";", 1)[0]?.trim() ?? "";
  return mimeType.length <= 128 &&
    /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : null;
}

function extraInfoMimeType(value: unknown): string | null {
  const headers = (value as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }
  const contentType = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === "content-type",
  )?.[1];
  return networkMimeType(contentType);
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
  restoreRecordedVideoFixturesImpl: typeof restoreRecordedVideoFixtures;
  cdpWebSocketFactory: ((url: string) => unknown) | null;
  diagnosticMilestones: unknown[] = [];
  stateObservations: unknown[] = [];
  consoleDiagnostics: unknown[] = [];
  exceptionDiagnostics: unknown[] = [];
  networkDiagnostics: unknown[] = [];
  networkRequests = new Map<string, NetworkRequestDiagnostic>();
  lastDomState: Record<string, unknown> | null = null;

  constructor({
    endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:19222",
    visionBaseUrl = process.env.VISION_BASE_URL ?? "http://127.0.0.1:27892",
    sourceGarmentMetadata = null,
    sourceGarmentServiceApiOrigin = null,
    selectRecordedVideoFixtureImpl = selectRecordedVideoFixture,
    restoreRecordedVideoFixturesImpl = restoreRecordedVideoFixtures,
    cdpWebSocketFactory = null,
  }: {
    endpoint?: string;
    visionBaseUrl?: string;
    sourceGarmentMetadata?: unknown;
    sourceGarmentServiceApiOrigin?: unknown;
    selectRecordedVideoFixtureImpl?: typeof selectRecordedVideoFixture;
    restoreRecordedVideoFixturesImpl?: typeof restoreRecordedVideoFixtures;
    cdpWebSocketFactory?: ((url: string) => unknown) | null;
  } = {}) {
    this.endpoint = endpoint;
    this.visionBaseUrl = visionBaseUrl;
    this.protocolEvidence = new VisionProtocolEvidenceCollector(visionBaseUrl);
    this.sourceGarmentMetadata = sourceGarmentMetadata;
    this.sourceGarmentServiceApiOrigin = sourceGarmentServiceApiOrigin;
    this.selectRecordedVideoFixtureImpl = selectRecordedVideoFixtureImpl;
    this.restoreRecordedVideoFixturesImpl = restoreRecordedVideoFixturesImpl;
    this.cdpWebSocketFactory = cdpWebSocketFactory;
  }

  private rememberNetworkRequest(
    requestId: string,
    update: Partial<NetworkRequestDiagnostic> = {},
    { reset = false }: { reset?: boolean } = {},
  ): NetworkRequestDiagnostic {
    const previous = reset
      ? emptyNetworkRequestDiagnostic()
      : (this.networkRequests.get(requestId) ??
        emptyNetworkRequestDiagnostic());
    const request = { ...previous, ...update };
    this.networkRequests.delete(requestId);
    this.networkRequests.set(requestId, request);
    while (this.networkRequests.size > MAX_NETWORK_REQUESTS) {
      const oldestRequestId = this.networkRequests.keys().next().value;
      if (typeof oldestRequestId !== "string") break;
      this.networkRequests.delete(oldestRequestId);
    }
    this.refreshLoadingFailedDiagnostics(requestId, request);
    return request;
  }

  private refreshLoadingFailedDiagnostics(
    requestId: string,
    request: NetworkRequestDiagnostic,
  ): void {
    for (const entry of this.networkDiagnostics) {
      const diagnostic = entry as Record<string, unknown>;
      if (
        diagnostic.kind !== "loadingFailed" ||
        diagnostic.requestId !== requestId
      ) {
        continue;
      }
      diagnostic.url = request.url;
      diagnostic.status = correlatedNetworkStatus(request);
      diagnostic.mimeType = correlatedNetworkMimeType(request);
      if (diagnostic.resourceType == null) {
        diagnostic.resourceType = request.resourceType;
      }
    }
  }

  private recordNetworkResponseEvidence(
    requestId: string | null,
    request: NetworkRequestDiagnostic,
  ): void {
    const status = correlatedNetworkStatus(request);
    if (request.resourceType !== "Image" && (status == null || status < 400)) {
      return;
    }
    boundedPush(
      this.networkDiagnostics,
      sanitizeDiagnosticValue({
        at: new Date().toISOString(),
        kind: status != null && status >= 400 ? "httpError" : "imageResponse",
        requestId,
        resourceType: request.resourceType,
        url: request.url,
        status,
        mimeType: correlatedNetworkMimeType(request),
      }),
    );
    request.responseEvidenceRecorded = true;
  }

  private reconcileNetworkResponseEvidence(
    requestId: string,
    request: NetworkRequestDiagnostic,
  ): void {
    const status = correlatedNetworkStatus(request);
    const shouldRecord =
      request.resourceType === "Image" || (status != null && status >= 400);
    if (request.responseEvidenceRecorded) {
      const diagnosticIndex = this.networkDiagnostics.findLastIndex((entry) => {
        const diagnostic = entry as Record<string, unknown>;
        return (
          diagnostic.requestId === requestId &&
          (diagnostic.kind === "imageResponse" ||
            diagnostic.kind === "httpError")
        );
      });
      if (diagnosticIndex >= 0) {
        if (!shouldRecord) {
          this.networkDiagnostics.splice(diagnosticIndex, 1);
          request.responseEvidenceRecorded = false;
          return;
        }
        const diagnostic = this.networkDiagnostics[diagnosticIndex] as Record<
          string,
          unknown
        >;
        diagnostic.kind =
          status != null && status >= 400 ? "httpError" : "imageResponse";
        diagnostic.resourceType = request.resourceType;
        diagnostic.url = request.url;
        diagnostic.status = status;
        diagnostic.mimeType = correlatedNetworkMimeType(request);
        return;
      }
      request.responseEvidenceRecorded = false;
    }
    if (request.responseObserved && shouldRecord) {
      this.recordNetworkResponseEvidence(requestId, request);
    }
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
    if (method === "Network.requestWillBeSent") {
      if (typeof value?.requestId !== "string") return;
      if (
        value?.redirectResponse &&
        typeof value.redirectResponse === "object"
      ) {
        const previous = this.networkRequests.get(value.requestId);
        const redirect = this.rememberNetworkRequest(value.requestId, {
          url:
            safeDiagnosticUrl(value.redirectResponse.url) ??
            previous?.url ??
            null,
          resourceType:
            typeof value?.type === "string"
              ? value.type.slice(0, 128)
              : (previous?.resourceType ?? null),
          responseStatus:
            networkStatus(value.redirectResponse.status) ??
            previous?.responseStatus ??
            null,
          responseMimeType:
            networkMimeType(value.redirectResponse.mimeType) ??
            previous?.responseMimeType ??
            null,
          responseObserved: true,
        });
        this.reconcileNetworkResponseEvidence(value.requestId, redirect);
      }
      const isRedirect = value?.redirectResponse != null;
      const current = this.networkRequests.get(value.requestId);
      const requestUrl = safeDiagnosticUrl(value?.request?.url);
      const requestResourceType =
        typeof value?.type === "string" ? value.type.slice(0, 128) : null;
      this.rememberNetworkRequest(
        value.requestId,
        {
          url: isRedirect ? requestUrl : (current?.url ?? requestUrl),
          resourceType: isRedirect
            ? requestResourceType
            : (current?.resourceType ?? requestResourceType),
        },
        { reset: isRedirect },
      );
      return;
    }
    if (method === "Network.responseReceivedExtraInfo") {
      if (typeof value?.requestId !== "string") return;
      const previous = this.networkRequests.get(value.requestId);
      const request = this.rememberNetworkRequest(value.requestId, {
        extraInfoStatus:
          networkStatus(value?.statusCode) ?? previous?.extraInfoStatus ?? null,
        extraInfoMimeType:
          extraInfoMimeType(value) ?? previous?.extraInfoMimeType ?? null,
      });
      this.reconcileNetworkResponseEvidence(value.requestId, request);
      return;
    }
    if (method === "Network.loadingFailed") {
      const request =
        typeof value?.requestId === "string"
          ? this.rememberNetworkRequest(value.requestId)
          : null;
      boundedPush(
        this.networkDiagnostics,
        sanitizeDiagnosticValue({
          at: new Date().toISOString(),
          kind: "loadingFailed",
          requestId: value?.requestId ?? null,
          resourceType: value?.type ?? null,
          errorText: value?.errorText ?? null,
          canceled: value?.canceled ?? false,
          url: request?.url ?? null,
          status: request ? correlatedNetworkStatus(request) : null,
          mimeType: request ? correlatedNetworkMimeType(request) : null,
        }),
      );
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId =
        typeof value?.requestId === "string" ? value.requestId : null;
      const status = networkStatus(value?.response?.status);
      const mimeType = networkMimeType(value?.response?.mimeType);
      const previous = requestId ? this.networkRequests.get(requestId) : null;
      const responseResourceType =
        typeof value?.type === "string"
          ? value.type.slice(0, 128)
          : (previous?.resourceType ?? null);
      const responseUrl =
        safeDiagnosticUrl(value?.response?.url) ?? previous?.url ?? null;
      const request = requestId
        ? this.rememberNetworkRequest(requestId, {
            url: responseUrl,
            resourceType: responseResourceType,
            responseStatus: status,
            responseMimeType: mimeType,
            responseObserved: true,
          })
        : ({
            ...emptyNetworkRequestDiagnostic(),
            url: responseUrl,
            resourceType: responseResourceType,
            responseStatus: status,
            responseMimeType: mimeType,
            responseObserved: true,
          } satisfies NetworkRequestDiagnostic);
      if (requestId) {
        this.reconcileNetworkResponseEvidence(requestId, request);
      } else {
        this.recordNetworkResponseEvidence(requestId, request);
      }
      return;
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
      this.cdpWebSocketFactory
        ? { webSocketFactory: this.cdpWebSocketFactory }
        : {},
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
    const stopRequest = this.client.on("Network.requestWillBeSent", (event) =>
      this.observeDiagnosticEvent("Network.requestWillBeSent", event),
    );
    const stopResponse = this.client.on("Network.responseReceived", (event) =>
      this.observeDiagnosticEvent("Network.responseReceived", event),
    );
    const stopResponseExtraInfo = this.client.on(
      "Network.responseReceivedExtraInfo",
      (event) =>
        this.observeDiagnosticEvent("Network.responseReceivedExtraInfo", event),
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
      stopRequest();
      stopResponse();
      stopResponseExtraInfo();
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
        kind: "touch",
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
    if (command === "restore-recorded-video-fixtures") {
      if (args.length !== 0) {
        throw new Error("restore-recorded-video-fixtures accepts no arguments");
      }
      return this.restoreRecordedVideoFixturesImpl();
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
    this.networkRequests.clear();
    this.lastDomState = null;
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

/** 仅调用生产 PowerShell seam；夹具信任、写入与 owner 生命周期都在同一模块内。 */
function invokeRecordedVideoFixtureSwitch(
  mode: "select" | "restore",
  segment?: "far" | "mid" | "near",
): CommandResult {
  const segmentArgument = segment ? ` -Segment '${segment}'` : "";
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$fixtureModulePath = Join-Path (Get-Location) 'scripts\testbed\recorded-video-fixture-decision.psm1'
Import-Module $fixtureModulePath -Force -ErrorAction Stop
Invoke-VemRecordedFixtureSwitch -Mode '${mode}'${segmentArgument} | ConvertTo-Json -Compress
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

/**
 * 仅由 testbed 环境提供三段录播文件名，原子替换 site config 后重启同一安装 owner。
 * 产品协议与业务代码不接受该命令；已安装产物未携带三段夹具时以非零结果 fail closed。
 */
export function selectRecordedVideoFixture(
  segment: "far" | "mid" | "near",
): CommandResult {
  return invokeRecordedVideoFixtureSwitch("select", segment);
}

/** 在每条 Vision acceptance 轨道后恢复已安装的默认录播对。 */
export function restoreRecordedVideoFixtures(): CommandResult {
  return invokeRecordedVideoFixtureSwitch("restore");
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
