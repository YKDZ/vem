import {
  type DaemonIpcAudioOutputBindingSnapshot,
  type DaemonIpcAudioOutputConfirmRequest,
  type DaemonIpcAudioOutputTestRequest,
  type DaemonIpcAudioOutputTestResponse,
  type EffectiveMachineRuntimeConfiguration,
  daemonIpcAudioOutputBindingSnapshotSchema,
  daemonIpcAudioOutputConfirmRequestSchema,
  daemonIpcAudioOutputTestRequestSchema,
  daemonIpcAudioOutputTestResponseSchema,
  effectiveMachineRuntimeConfigurationSchema,
  isManagedMediaReference,
  stockMaintenanceBatchResponseSchema,
  stockMaintenanceTaskSchema,
  type StockMaintenanceBatchRequest,
  type StockMaintenanceBatchResponse,
  type StockMaintenanceTask,
  type VisionCameraMaintenanceConfirmRequest,
  type VisionCameraMaintenanceRole,
  type VisionCameraMaintenanceTestRequest,
} from "@vem/shared";

import { managedMediaDiagnosticKey } from "@/catalog/managed-media";
import {
  getDaemonConnectionInfo,
  type DaemonConnectionInfo,
} from "@/native/daemon-connection";

import {
  catalogSnapshotSchema,
  bringUpSnapshotSchema,
  configSummaryFromRuntimeConfigurationSummary,
  daemonEventSchema,
  hardwareSelfCheckSchema,
  manualDispenseDiagnosticResultSchema,
  deviceBindingActivationSchema,
  deviceBindingSnapshotSchema,
  deviceBindingTestResultSchema,
  environmentControlResultSchema,
  healthSnapshotSchema,
  machinePaymentOptionsResponseSchema,
  paymentProviderEnvironmentDiagnosticSchema,
  machineSaleReadinessSchema,
  naturalContextSnapshotSchema,
  networkSettingsResponseSchema,
  readySnapshotSchema,
  remoteOpsStatusSchema,
  machineSaleViewSnapshotSchema,
  maintenanceEnrollmentStatusSchema,
  maintenanceSessionSchema,
  scannerStatusSchema,
  syncStatusSchema,
  transactionSnapshotSchema,
  visionStatusSchema,
  wifiScanResponseSchema,
  type CatalogSnapshot,
  type BringUpSnapshot,
  type ConfigSummary,
  type DaemonEvent,
  type HealthSnapshot,
  type HardwareSelfCheck,
  type DeviceBindingActivation,
  type DeviceBindingSnapshot,
  type DeviceBindingTestResult,
  type EnvironmentControlResult,
  type MachineSaleReadiness,
  type PaymentProviderEnvironmentDiagnostic,
  type NaturalContextSnapshot,
  type MaintenanceEnrollmentStatus,
  type MaintenanceSession,
  type NetworkSettingsResponse,
  type ReadySnapshot,
  type RemoteOpsStatus,
  type SaleViewSnapshot,
  type ScannerStatus,
  type SyncStatus,
  type TransactionSnapshot,
  type UnknownDaemonEvent,
  type VisionStatus,
  type VisionCameraMaintenanceConfirmResponse,
  type VisionCameraMaintenanceContract,
  type VisionCameraMaintenanceTestResponse,
  type WifiScanResponse,
  visionCameraMaintenanceConfirmResponseProxySchema,
  visionCameraMaintenanceContractResponseSchema,
  visionCameraMaintenanceTestResponseProxySchema,
} from "./schemas";

function normalizeSaleViewManagedMedia(payload: unknown): {
  payload: unknown;
  mediaDiagnostics: SaleViewSnapshot["mediaDiagnostics"];
} {
  if (!isRecord(payload) || !isUnknownArray(payload.items)) {
    return { payload, mediaDiagnostics: [] };
  }

  const mediaDiagnostics: Array<
    NonNullable<SaleViewSnapshot["mediaDiagnostics"]>[number]
  > = [];
  const items = payload.items.map((item, index) => {
    if (!isRecord(item)) {
      return item;
    }
    const normalized = { ...item };
    const itemIdentity =
      typeof normalized.slotId === "string"
        ? normalized.slotId
        : `index-${index}`;
    for (const field of ["coverImageUrl", "tryOnSilhouetteUrl"] as const) {
      const reference = normalized[field];
      if (typeof reference === "string" && isManagedMediaReference(reference)) {
        continue;
      }
      mediaDiagnostics.push({
        reference: typeof reference === "string" ? reference : null,
        diagnosticKey: managedMediaDiagnosticKey(
          `media:${itemIdentity}:${field}`,
          reference,
        ),
        message:
          reference === null || reference === undefined
            ? `daemon sale view contained no ${field} managed media reference`
            : `daemon sale view contained an invalid ${field} managed media reference`,
      });
      normalized[field] = null;
    }
    return normalized;
  });
  return { payload: { ...payload, items }, mediaDiagnostics };
}

export class DaemonUnavailableError extends Error {
  public readonly cause?: unknown;
  public readonly statusCode?: number;
  public readonly responseCode?: string;
  public readonly responseMessage?: string;
  public readonly responseBody?: string;

  constructor(
    message = "daemon unavailable",
    cause?: unknown,
    metadata: {
      statusCode?: number;
      responseCode?: string;
      responseMessage?: string;
      responseBody?: string;
    } = {},
  ) {
    super(message);
    this.name = "DaemonUnavailableError";
    this.cause = cause;
    this.statusCode = metadata.statusCode;
    this.responseCode = metadata.responseCode;
    this.responseMessage = metadata.responseMessage;
    this.responseBody = metadata.responseBody;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  retry401?: boolean;
  maintenanceSessionOverride?: MaintenanceSession | null;
  signal?: AbortSignal;
};

type Subscription = {
  close(): void;
};

export type MaintenanceSessionRouteScope = "maintenance" | "bring-up";

const MAX_SEEN_EVENT_IDS = 1000;
// Network setup failures carry five independently typed diagnostics.  Leave
// ample room for all operator guidance while bounding untrusted daemon output
// in the kiosk renderer.  Never parse a truncated JSON prefix.
const MAX_DAEMON_RESPONSE_BYTES = 64 * 1024;

type BoundedResponseText =
  | { exceeded: false; text: string }
  | { exceeded: true };

async function readDaemonResponseText(
  response: Response,
): Promise<BoundedResponseText> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_DAEMON_RESPONSE_BYTES
  ) {
    return { exceeded: true };
  }

  if (!response.body) return { exceeded: false, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- a response stream must be read sequentially and remains size-bounded.
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DAEMON_RESPONSE_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- cancel the same sequential reader before returning the bounded failure.
        await reader.cancel().catch(() => undefined);
        return { exceeded: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, text: new TextDecoder().decode(body) };
}
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAINTENANCE_REVOKE_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export class DaemonApiClient {
  private connection: DaemonConnectionInfo | null = null;
  private maintenanceSession: MaintenanceSession | null = null;
  // A session is daemon-owned state, but this route scope makes the browser
  // handoff explicit: Maintenance may issue it and only Bring-Up may receive
  // it. A normal route departure drops the browser-side bearer immediately.
  private maintenanceSessionRouteScope: MaintenanceSessionRouteScope | null =
    null;
  private maintenanceSessionExpiryTimer: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;
  private readonly maintenanceSessionInvalidationListeners = new Set<
    () => void
  >();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventIdQueue: string[] = [];

  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const connection = await this.initialize();
    const maintenanceSession =
      options.maintenanceSessionOverride === undefined
        ? this.currentMaintenanceSession
        : options.maintenanceSessionOverride;
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
        ...(maintenanceSession
          ? { "x-vem-maintenance-session": maintenanceSession.sessionId }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    }).catch((error: unknown) => {
      throw new DaemonUnavailableError("daemon request failed", error);
    });

    if (response.status === 401 && options.retry401 !== false) {
      // A 401 means the daemon connection has changed (normally a restart).
      // Maintenance capabilities are daemon-memory state and cannot survive it.
      this.clearMaintenanceSession();
      await this.initialize(true);
      return this.request(path, { ...options, retry401: false });
    }

    const body = await readDaemonResponseText(response).catch(
      (error: unknown) => {
        throw new DaemonUnavailableError(
          "could not read daemon response",
          error,
          {
            statusCode: response.status,
          },
        );
      },
    );
    const statusMessage = `${path} returned HTTP ${response.status}`;

    if (!response.ok) {
      if (response.status === 403 && maintenanceSession) {
        // The daemon owns session state. A restart or scope denial must not
        // leave a stale browser-side capability displayed as authorized.
        this.clearMaintenanceSessionForId(maintenanceSession.sessionId);
      }
      if (body.exceeded) {
        throw new DaemonUnavailableError(
          `${statusMessage}; response body exceeds the safe read limit`,
          undefined,
          { statusCode: response.status },
        );
      }
      const { text } = body;
      let responseCode: string | undefined;
      let responseMessage: string | undefined;
      try {
        const parsed = text ? (JSON.parse(text) as unknown) : null;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "code" in parsed &&
          typeof parsed.code === "string"
        ) {
          responseCode = parsed.code;
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "message" in parsed &&
          typeof parsed.message === "string"
        ) {
          responseMessage = parsed.message;
        }
      } catch {
        responseCode = undefined;
        responseMessage = undefined;
      }
      throw new DaemonUnavailableError(
        responseMessage
          ? `${responseMessage} (${statusMessage})`
          : statusMessage,
        undefined,
        {
          statusCode: response.status,
          responseCode,
          responseMessage,
          // This is either the complete bounded response or absent above;
          // callers must never see a sliced JSON document.
          responseBody: text,
        },
      );
    }

    if (body.exceeded) {
      throw new DaemonUnavailableError(
        `${path} response exceeds the safe read limit`,
        undefined,
        { statusCode: response.status },
      );
    }
    const { text } = body;
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed;
  }

  private async requestBlob(
    path: string,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<Blob> {
    const connection = await this.initialize();
    const maintenanceSession = this.currentMaintenanceSession;
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(maintenanceSession
          ? { "x-vem-maintenance-session": maintenanceSession.sessionId }
          : {}),
      },
    }).catch((error: unknown) => {
      throw new DaemonUnavailableError("daemon request failed", error);
    });

    if (response.status === 401 && options.retry401 !== false) {
      this.clearMaintenanceSession();
      await this.initialize(true);
      return this.requestBlob(path, { ...options, retry401: false });
    }

    if (!response.ok) {
      const body = await readDaemonResponseText(response).catch(() => ({
        exceeded: false as const,
        text: "",
      }));
      throw new DaemonUnavailableError(
        `${path} returned HTTP ${response.status}`,
        undefined,
        {
          statusCode: response.status,
          responseBody: body.exceeded ? undefined : body.text,
        },
      );
    }

    return response.blob();
  }

  async initialize(force = false): Promise<DaemonConnectionInfo> {
    if (!this.connection || force) {
      this.connection = await getDaemonConnectionInfo();
    }
    return this.connection;
  }

  get currentConnection(): DaemonConnectionInfo | null {
    return this.connection;
  }

  get currentMaintenanceSession(): MaintenanceSession | null {
    if (
      this.maintenanceSession &&
      Date.parse(this.maintenanceSession.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return this.maintenanceSession;
  }

  hasMaintenanceSessionForRoute(route: MaintenanceSessionRouteScope): boolean {
    return (
      this.currentMaintenanceSession !== null &&
      this.maintenanceSessionRouteScope === route
    );
  }

  getMaintenanceSessionForRoute(
    route: MaintenanceSessionRouteScope,
  ): MaintenanceSession | null {
    return this.hasMaintenanceSessionForRoute(route)
      ? this.currentMaintenanceSession
      : null;
  }

  async getHealth(): Promise<HealthSnapshot> {
    return healthSnapshotSchema.parse(await this.request("/healthz"));
  }

  async getReady(): Promise<ReadySnapshot> {
    return readySnapshotSchema.parse(await this.request("/readyz"));
  }

  async getBringUp(): Promise<BringUpSnapshot> {
    return bringUpSnapshotSchema.parse(await this.request("/v1/bring-up"));
  }

  async executeBringUpTask(
    task: NonNullable<BringUpSnapshot["currentTask"]>,
    mutation: unknown,
  ): Promise<unknown> {
    const maintenanceSession = this.currentMaintenanceSession;
    const protectedMutation =
      task.kind === "reclaim_machine" &&
      isRecord(mutation) &&
      mutation.type === "claim_machine" &&
      maintenanceSession
        ? {
            ...mutation,
            maintenanceAuthorization: {
              sessionId: maintenanceSession.sessionId,
            },
          }
        : mutation;
    try {
      return await this.request("/v1/bring-up/tasks/execute", {
        method: "POST",
        body: {
          contractVersion: task.contractVersion,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          kind: task.kind,
          intent: task.intent,
          mutation: protectedMutation,
        },
      });
    } catch (error: unknown) {
      // The cursor uses 400/422 for a completed network attempt whose
      // diagnostics are meaningful to the operator. Keep those typed facts
      // instead of replacing them with a generic transport failure.
      const structured = parseNetworkSettingsRejection(error);
      if (structured) return structured;
      throw error;
    }
  }

  async scanWifiNetworks(): Promise<WifiScanResponse> {
    return wifiScanResponseSchema.parse(
      await this.request("/v1/network/available"),
    );
  }

  async getConfig(): Promise<ConfigSummary> {
    return configSummaryFromRuntimeConfigurationSummary(
      await this.request("/v1/config/summary"),
    );
  }

  async getEffectiveRuntimeConfiguration(): Promise<EffectiveMachineRuntimeConfiguration> {
    return effectiveMachineRuntimeConfigurationSchema.parse(
      await this.request("/v1/runtime-configuration"),
    );
  }

  async getAudioOutputBinding(): Promise<DaemonIpcAudioOutputBindingSnapshot> {
    return daemonIpcAudioOutputBindingSnapshotSchema.parse(
      await this.request("/v1/audio-output-binding"),
    );
  }

  async testAudioOutput(
    body: DaemonIpcAudioOutputTestRequest,
  ): Promise<DaemonIpcAudioOutputTestResponse> {
    const request = daemonIpcAudioOutputTestRequestSchema.parse(body);
    return daemonIpcAudioOutputTestResponseSchema.parse(
      await this.request("/v1/audio-output-binding/test", {
        method: "POST",
        body: request,
      }),
    );
  }

  async confirmAudioOutput(
    body: DaemonIpcAudioOutputConfirmRequest,
  ): Promise<ConfigSummary> {
    const request = daemonIpcAudioOutputConfirmRequestSchema.parse(body);
    return configSummaryFromRuntimeConfigurationSummary(
      await this.request("/v1/audio-output-binding/confirm", {
        method: "POST",
        body: request,
      }),
    );
  }

  async saveConfig(_body: unknown): Promise<never> {
    throw new DaemonUnavailableError(
      "直接配置编辑已禁用；请通过守护进程 Bring-Up 流程完成部署。",
    );
  }

  async getMaintenanceStatus(): Promise<MaintenanceEnrollmentStatus> {
    return maintenanceEnrollmentStatusSchema.parse(
      await this.request("/v1/maintenance/status"),
    );
  }

  async beginMaintenanceSession(
    pin: string,
    scopes: string[] = [],
    operatorId = "front-panel",
  ): Promise<MaintenanceSession> {
    const session = maintenanceSessionSchema.parse(
      await this.request("/v1/maintenance/sessions", {
        method: "POST",
        body: { pin, scopes, operatorId },
      }),
    );
    this.maintenanceSession = session;
    this.maintenanceSessionRouteScope = "maintenance";
    this.scheduleMaintenanceSessionExpiry();
    return session;
  }

  handoffMaintenanceSessionToBringUp(): boolean {
    if (!this.hasMaintenanceSessionForRoute("maintenance")) {
      return false;
    }
    this.maintenanceSessionRouteScope = "bring-up";
    return true;
  }

  handoffMaintenanceSessionToMaintenance(): boolean {
    if (!this.hasMaintenanceSessionForRoute("bring-up")) {
      return false;
    }
    this.maintenanceSessionRouteScope = "maintenance";
    return true;
  }

  releaseMaintenanceSessionRoute(route: MaintenanceSessionRouteScope): void {
    if (this.maintenanceSessionRouteScope === route) {
      this.clearMaintenanceSession();
    }
  }

  async revokeMaintenanceSessionRoute(
    route: MaintenanceSessionRouteScope,
  ): Promise<void> {
    const session = this.maintenanceSession;
    if (this.maintenanceSessionRouteScope !== route || !session) {
      return;
    }
    await this.revokeCapturedMaintenanceSession(session);
  }

  private async revokeCapturedMaintenanceSession(
    session: MaintenanceSession,
  ): Promise<void> {
    const abort = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      abort.abort();
    }, MAINTENANCE_REVOKE_TIMEOUT_MS);
    try {
      await this.request("/v1/maintenance/sessions/revoke", {
        method: "POST",
        retry401: false,
        maintenanceSessionOverride: session,
        signal: abort.signal,
      });
    } finally {
      globalThis.clearTimeout(timeout);
      this.clearMaintenanceSessionForId(session.sessionId);
    }
  }

  onMaintenanceSessionInvalidated(listener: () => void): () => void {
    this.maintenanceSessionInvalidationListeners.add(listener);
    return () => {
      this.maintenanceSessionInvalidationListeners.delete(listener);
    };
  }

  clearMaintenanceSession(): void {
    if (this.maintenanceSessionExpiryTimer !== null) {
      globalThis.clearTimeout(this.maintenanceSessionExpiryTimer);
      this.maintenanceSessionExpiryTimer = null;
    }
    const hadSession = this.maintenanceSession !== null;
    this.maintenanceSession = null;
    this.maintenanceSessionRouteScope = null;
    if (!hadSession) return;
    for (const listener of this.maintenanceSessionInvalidationListeners) {
      listener();
    }
  }

  private clearMaintenanceSessionForId(sessionId: string): void {
    if (this.maintenanceSession?.sessionId === sessionId) {
      this.clearMaintenanceSession();
    }
  }

  private scheduleMaintenanceSessionExpiry(): void {
    if (this.maintenanceSessionExpiryTimer !== null) {
      globalThis.clearTimeout(this.maintenanceSessionExpiryTimer);
      this.maintenanceSessionExpiryTimer = null;
    }
    const session = this.maintenanceSession;
    if (!session) return;
    const remainingMs = Date.parse(session.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      void this.revokeCapturedMaintenanceSession(session).catch(
        () => undefined,
      );
      return;
    }
    this.maintenanceSessionExpiryTimer = globalThis.setTimeout(
      () => {
        this.maintenanceSessionExpiryTimer = null;
        if (this.maintenanceSession?.sessionId !== session.sessionId) return;
        if (Date.parse(session.expiresAt) > Date.now()) {
          this.scheduleMaintenanceSessionExpiry();
          return;
        }
        void this.revokeCapturedMaintenanceSession(session).catch(() => {
          // The revoke method clears this exact local session in finally.
        });
      },
      Math.min(remainingMs, MAX_TIMEOUT_MS),
    );
  }

  async getCatalog(): Promise<CatalogSnapshot> {
    return catalogSnapshotSchema.parse(await this.request("/v1/catalog"));
  }

  async refreshCatalog(): Promise<CatalogSnapshot> {
    return catalogSnapshotSchema.parse(
      await this.request("/v1/catalog", { method: "POST" }),
    );
  }

  async getSaleView(): Promise<SaleViewSnapshot> {
    const normalized = normalizeSaleViewManagedMedia(
      await this.request("/v1/sale-view"),
    );
    return {
      ...machineSaleViewSnapshotSchema.parse(normalized.payload),
      mediaDiagnostics: normalized.mediaDiagnostics,
    };
  }

  async recordStockMovement(body: unknown): Promise<SaleViewSnapshot> {
    return machineSaleViewSnapshotSchema.parse(
      await this.request("/v1/stock/movements", {
        method: "POST",
        body,
      }),
    );
  }

  async getStockMaintenanceTask(): Promise<StockMaintenanceTask> {
    return stockMaintenanceTaskSchema.parse(
      await this.request("/v1/stock/maintenance-task"),
    );
  }

  async submitStockMaintenanceBatch(
    body: StockMaintenanceBatchRequest,
  ): Promise<StockMaintenanceBatchResponse> {
    return stockMaintenanceBatchResponseSchema.parse(
      await this.request("/v1/stock/maintenance-task", {
        method: "POST",
        body,
      }),
    );
  }

  async clearWholeMachineMaintenanceLock(
    operatorNote: string,
  ): Promise<unknown> {
    return this.request("/v1/maintenance/whole-machine-lock/clear", {
      method: "POST",
      body: { operatorNote },
    });
  }

  async getSaleReadiness(): Promise<MachineSaleReadiness> {
    return machineSaleReadinessSchema.parse(
      await this.request("/v1/sale-readiness"),
    );
  }

  async getPaymentOptions() {
    return machinePaymentOptionsResponseSchema.parse(
      await this.request("/v1/payment-options"),
    );
  }

  async getPaymentEnvironmentDiagnostic(): Promise<PaymentProviderEnvironmentDiagnostic> {
    return paymentProviderEnvironmentDiagnosticSchema.parse(
      await this.request("/v1/maintenance/payment-environment"),
    );
  }

  async createOrder(body: unknown): Promise<TransactionSnapshot> {
    return transactionSnapshotSchema.parse(
      await this.request("/v1/intents/create-order", {
        method: "POST",
        body,
      }),
    );
  }

  async cancelOrder(orderNo: string): Promise<TransactionSnapshot> {
    return transactionSnapshotSchema.parse(
      await this.request("/v1/intents/cancel-order", {
        method: "POST",
        body: { orderNo },
      }),
    );
  }

  async submitDevPaymentCode(body: unknown): Promise<TransactionSnapshot> {
    return transactionSnapshotSchema.parse(
      await this.request("/v1/intents/dev-submit-payment-code", {
        method: "POST",
        body,
      }),
    );
  }

  async getCurrentTransaction(): Promise<TransactionSnapshot> {
    return transactionSnapshotSchema.parse(
      await this.request("/v1/transactions/current"),
    );
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return syncStatusSchema.parse(await this.request("/v1/sync/status"));
  }

  async getScannerStatus(): Promise<ScannerStatus> {
    return scannerStatusSchema.parse(await this.request("/v1/scanner/status"));
  }

  async getVisionStatus(): Promise<VisionStatus> {
    return visionStatusSchema.parse(await this.request("/v1/vision/status"));
  }

  async getVisionCameraMaintenanceContract(): Promise<VisionCameraMaintenanceContract> {
    return visionCameraMaintenanceContractResponseSchema.parse(
      await this.request("/v1/vision/camera-maintenance"),
    );
  }

  async refreshVisionCameraMaintenanceContract(): Promise<VisionCameraMaintenanceContract> {
    return visionCameraMaintenanceContractResponseSchema.parse(
      await this.request("/v1/vision/camera-maintenance/refresh", {
        method: "POST",
      }),
    );
  }

  async getVisionCameraMaintenancePreviewBlob(
    candidateId: string,
  ): Promise<Blob> {
    return this.requestBlob(
      `/v1/vision/camera-maintenance/candidates/${encodeURIComponent(candidateId)}/preview.jpg`,
    );
  }

  async testVisionCameraRole(
    role: VisionCameraMaintenanceRole,
    request: VisionCameraMaintenanceTestRequest,
  ): Promise<VisionCameraMaintenanceTestResponse> {
    return visionCameraMaintenanceTestResponseProxySchema.parse(
      await this.request(`/v1/vision/camera-maintenance/roles/${role}/test`, {
        method: "POST",
        body: request,
      }),
    );
  }

  async confirmVisionCameraRole(
    role: VisionCameraMaintenanceRole,
    request: VisionCameraMaintenanceConfirmRequest,
  ): Promise<VisionCameraMaintenanceConfirmResponse> {
    return visionCameraMaintenanceConfirmResponseProxySchema.parse(
      await this.request(
        `/v1/vision/camera-maintenance/roles/${role}/confirm`,
        {
          method: "POST",
          body: request,
        },
      ),
    );
  }

  async getNaturalContext(): Promise<NaturalContextSnapshot> {
    return naturalContextSnapshotSchema.parse(
      await this.request("/v1/natural-context"),
    );
  }

  async getRemoteOpsStatus(): Promise<RemoteOpsStatus> {
    return remoteOpsStatusSchema.parse(
      await this.request("/v1/remote-ops/status"),
    );
  }

  async runHardwareSelfCheck(): Promise<HardwareSelfCheck> {
    return hardwareSelfCheckSchema.parse(
      await this.request("/v1/hardware/self-check", { method: "POST" }),
    );
  }

  async runManualDispenseDiagnostic(body: unknown) {
    return manualDispenseDiagnosticResultSchema.parse(
      await this.request("/v1/maintenance/manual-dispense-diagnostic", {
        method: "POST",
        body,
      }),
    );
  }

  async getDeviceBindings(): Promise<DeviceBindingSnapshot> {
    return deviceBindingSnapshotSchema.parse(
      await this.request("/v1/hardware-bindings"),
    );
  }

  async testDeviceBinding(
    role: "lower_controller" | "scanner",
    identityKey: string,
  ): Promise<DeviceBindingTestResult> {
    return deviceBindingTestResultSchema.parse(
      await this.request(`/v1/hardware-bindings/${role}/test`, {
        method: "POST",
        body: { identityKey },
      }),
    );
  }

  async confirmDeviceBinding(
    role: "lower_controller" | "scanner",
    identityKey: string,
    testEvidenceToken: string,
  ): Promise<DeviceBindingActivation> {
    return deviceBindingActivationSchema.parse(
      await this.request(`/v1/hardware-bindings/${role}/confirm`, {
        method: "POST",
        body: { identityKey, testEvidenceToken },
      }),
    );
  }

  async controlEnvironment(body: unknown): Promise<EnvironmentControlResult> {
    return environmentControlResultSchema.parse(
      await this.request("/v1/environment/control", {
        method: "POST",
        body,
      }),
    );
  }

  async markMockPayment(
    orderNo: string,
    succeed: boolean,
  ): Promise<TransactionSnapshot> {
    return transactionSnapshotSchema.parse(
      await this.request("/v1/intents/mock-payment", {
        method: "POST",
        body: {
          orderNo,
          succeed,
        },
      }),
    );
  }

  async downloadLogExport(): Promise<Response> {
    const connection = await this.initialize();
    const response = await fetch(`${connection.baseUrl}/v1/logs/export`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!response.ok) {
      if (response.status === 401) {
        this.clearMaintenanceSession();
      }
      throw new DaemonUnavailableError(
        `/v1/logs/export returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  subscribeEvents(handlers: {
    onEvent: (event: DaemonEvent) => void;
    onUnknownEvent?: (event: UnknownDaemonEvent) => void;
    onError: (error: Error) => void;
    onStale: () => void;
  }): Subscription {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryMs = 500;

    const connect = async (): Promise<void> => {
      const connection = await this.initialize(true);
      const url = `${connection.baseUrl.replace(/^[hH][tT][tT][pP]/, "ws")}/v1/events?token=${encodeURIComponent(connection.token)}`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (closed) return;
        retryMs = 500;
      };
      socket.onmessage = (message) => {
        if (closed) return;
        const event = daemonEventSchema.parse(JSON.parse(String(message.data)));
        if ("known" in event) {
          handlers.onUnknownEvent?.(event);
          return;
        }
        if (this.seenEventIds.has(event.eventId)) return;
        this.seenEventIds.add(event.eventId);
        this.seenEventIdQueue.push(event.eventId);
        while (this.seenEventIdQueue.length > MAX_SEEN_EVENT_IDS) {
          const expired = this.seenEventIdQueue.shift();
          if (expired) this.seenEventIds.delete(expired);
        }
        handlers.onEvent(event);
      };
      socket.onerror = () => {
        if (closed) return;
        handlers.onError(
          new DaemonUnavailableError("daemon event stream error"),
        );
      };
      socket.onclose = () => {
        if (closed) return;
        // WebSocket disconnect is the only direct restart signal the kiosk
        // receives. Treat it as an invalidated daemon-owned session.
        this.clearMaintenanceSession();
        handlers.onStale();
        globalThis.setTimeout(() => {
          void connect().catch((error: unknown) => {
            handlers.onError(
              error instanceof Error
                ? error
                : new DaemonUnavailableError(String(error)),
            );
          });
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
    };

    void connect().catch((error: unknown) => {
      handlers.onError(
        error instanceof Error
          ? error
          : new DaemonUnavailableError(String(error)),
      );
    });

    return {
      close: () => {
        closed = true;
        if (socket) {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.close();
        }
        socket = null;
      },
    };
  }
}

export const daemonClient = new DaemonApiClient();

export function parseNetworkSettingsRejection(
  error: unknown,
): NetworkSettingsResponse | null {
  if (!(error instanceof DaemonUnavailableError)) return null;
  if (error.statusCode !== 400 && error.statusCode !== 422) return null;
  if (!error.responseBody) return null;

  try {
    const parsed: unknown = JSON.parse(error.responseBody);
    const result = networkSettingsResponseSchema.safeParse(parsed);
    if (!result.success) return null;
    if (
      result.data.status !== "failed" &&
      result.data.status !== "unsupported"
    ) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}
