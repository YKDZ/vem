import {
  type ClearHardwareBindingRequest,
  type ConfirmHardwareBindingRequest,
  type EffectiveMachineRuntimeConfiguration,
  type SetAudioPreferencesRequest,
  type SetScannerProtocolParametersRequest,
  clearHardwareBindingRequestSchema,
  confirmHardwareBindingRequestSchema,
  effectiveMachineRuntimeConfigurationSchema,
  setAudioPreferencesRequestSchema,
  setScannerProtocolParametersRequestSchema,
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
  daemonEventSchema,
  hardwareSelfCheckSchema,
  manualDispenseDiagnosticResultSchema,
  deviceBindingActivationSchema,
  deviceBindingSnapshotSchema,
  deviceBindingTestResultSchema,
  environmentControlResultSchema,
  healthSnapshotSchema,
  paymentProviderEnvironmentDiagnosticSchema,
  saleStartCapabilitySnapshotSchema,
  naturalContextSnapshotSchema,
  networkSettingsResponseSchema,
  readySnapshotSchema,
  remoteOpsStatusSchema,
  machineSaleViewSnapshotSchema,
  maintenanceEnrollmentStatusSchema,
  provisioningClaimResponseSchema,
  scannerStatusSchema,
  syncStatusSchema,
  transactionSnapshotSchema,
  visionStatusSchema,
  wifiScanResponseSchema,
  type CatalogSnapshot,
  type DaemonEvent,
  type HealthSnapshot,
  type HardwareSelfCheck,
  type DeviceBindingActivation,
  type DeviceBindingSnapshot,
  type DeviceBindingTestResult,
  type EnvironmentControlResult,
  type SaleStartCapabilitySnapshot,
  type PaymentProviderEnvironmentDiagnostic,
  type NaturalContextSnapshot,
  type MaintenanceEnrollmentStatus,
  type NetworkSettingsResponse,
  type ProvisioningClaimResponse,
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

export function isDaemonTransportFailure(error: unknown): boolean {
  return (
    error instanceof DaemonUnavailableError &&
    (error.statusCode === undefined || error.cause !== undefined)
  );
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  retry401?: boolean;
  signal?: AbortSignal;
};

type Subscription = {
  close(): void;
};

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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export class DaemonApiClient {
  private connection: DaemonConnectionInfo | null = null;

  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const connection = await this.initialize();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    }).catch((error: unknown) => {
      throw new DaemonUnavailableError("daemon request failed", error);
    });

    if (response.status === 401 && options.retry401 !== false) {
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
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
      },
    }).catch((error: unknown) => {
      throw new DaemonUnavailableError("daemon request failed", error);
    });

    if (response.status === 401 && options.retry401 !== false) {
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

  async getHealth(): Promise<HealthSnapshot> {
    return healthSnapshotSchema.parse(await this.request("/healthz"));
  }

  async getReady(): Promise<ReadySnapshot> {
    return readySnapshotSchema.parse(await this.request("/readyz"));
  }

  async scanWifiNetworks(): Promise<WifiScanResponse> {
    return wifiScanResponseSchema.parse(
      await this.request("/v1/network/available"),
    );
  }

  async getEffectiveRuntimeConfiguration(): Promise<EffectiveMachineRuntimeConfiguration> {
    return effectiveMachineRuntimeConfigurationSchema.parse(
      await this.request("/v1/runtime-configuration"),
    );
  }

  async applyNetworkSettings(input: {
    ssid: string;
    password: string;
    hidden: boolean;
  }): Promise<NetworkSettingsResponse> {
    try {
      return networkSettingsResponseSchema.parse(
        await this.request("/v1/network/settings", {
          method: "POST",
          body: input,
        }),
      );
    } catch (error) {
      const structured = parseNetworkSettingsRejection(error);
      if (structured) return structured;
      throw error;
    }
  }

  async claimMachine(claimCode: string): Promise<ProvisioningClaimResponse> {
    return provisioningClaimResponseSchema.parse(
      await this.request("/v1/provisioning/claim", {
        method: "POST",
        body: { claimCode: claimCode.trim().toUpperCase() },
      }),
    );
  }

  async getMaintenanceStatus(): Promise<MaintenanceEnrollmentStatus> {
    return maintenanceEnrollmentStatusSchema.parse(
      await this.request("/v1/maintenance/status"),
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

  async getSaleStartCapability(): Promise<SaleStartCapabilitySnapshot> {
    return saleStartCapabilitySnapshotSchema.parse(
      await this.request("/v1/sale-start-capability"),
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
    const request: ConfirmHardwareBindingRequest =
      confirmHardwareBindingRequestSchema.parse({
        identityKey,
        testEvidenceToken,
      });
    return deviceBindingActivationSchema.parse(
      await this.request(
        `/v1/runtime-configuration/intents/hardware-bindings/${role}/confirm`,
        {
          method: "POST",
          body: request,
        },
      ),
    );
  }

  async clearDeviceBinding(
    role: "lower_controller" | "scanner",
  ): Promise<EffectiveMachineRuntimeConfiguration> {
    const request: ClearHardwareBindingRequest =
      clearHardwareBindingRequestSchema.parse({});
    return effectiveMachineRuntimeConfigurationSchema.parse(
      await this.request(
        `/v1/runtime-configuration/intents/hardware-bindings/${role}/clear`,
        {
          method: "POST",
          body: request,
        },
      ),
    );
  }

  async setScannerProtocolParameters(
    body: SetScannerProtocolParametersRequest,
  ): Promise<EffectiveMachineRuntimeConfiguration> {
    const request = setScannerProtocolParametersRequestSchema.parse(body);
    return effectiveMachineRuntimeConfigurationSchema.parse(
      await this.request(
        "/v1/runtime-configuration/intents/scanner-protocol-parameters",
        { method: "POST", body: request },
      ),
    );
  }

  async setAudioPreferences(
    body: SetAudioPreferencesRequest,
  ): Promise<EffectiveMachineRuntimeConfiguration> {
    const request = setAudioPreferencesRequestSchema.parse(body);
    return effectiveMachineRuntimeConfigurationSchema.parse(
      await this.request(
        "/v1/runtime-configuration/intents/audio-preferences",
        {
          method: "POST",
          body: request,
        },
      ),
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
    onOpen?: (input: { reconnected: boolean }) => void;
    onReconnect?: () => void;
  }): Subscription {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryMs = 500;
    let hasOpened = false;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const seenEventIds = new Set<string>();
    const seenEventIdQueue: string[] = [];

    const scheduleReconnect = (): void => {
      if (closed || retryTimer !== null) return;
      const delayMs = retryMs;
      retryMs = Math.min(retryMs * 2, 10_000);
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        void connect().catch((error: unknown) => {
          handlers.onError(
            error instanceof Error
              ? error
              : new DaemonUnavailableError(String(error)),
          );
          scheduleReconnect();
        });
      }, delayMs);
    };

    const connect = async (): Promise<void> => {
      const connection = await this.initialize(true);
      const url = `${connection.baseUrl.replace(/^[hH][tT][tT][pP]/, "ws")}/v1/events?token=${encodeURIComponent(connection.token)}`;
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (closed) return;
        const reconnected = hasOpened;
        hasOpened = true;
        retryMs = 500;
        handlers.onOpen?.({ reconnected });
        if (reconnected) handlers.onReconnect?.();
      };
      socket.onmessage = (message) => {
        if (closed) return;
        const event = daemonEventSchema.parse(JSON.parse(String(message.data)));
        if ("known" in event) {
          handlers.onUnknownEvent?.(event);
          return;
        }
        if (seenEventIds.has(event.eventId)) return;
        seenEventIds.add(event.eventId);
        seenEventIdQueue.push(event.eventId);
        while (seenEventIdQueue.length > MAX_SEEN_EVENT_IDS) {
          const expired = seenEventIdQueue.shift();
          if (expired) seenEventIds.delete(expired);
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
        handlers.onStale();
        scheduleReconnect();
      };
    };

    void connect().catch((error: unknown) => {
      handlers.onError(
        error instanceof Error
          ? error
          : new DaemonUnavailableError(String(error)),
      );
      scheduleReconnect();
    });

    return {
      close: () => {
        closed = true;
        if (retryTimer !== null) {
          globalThis.clearTimeout(retryTimer);
          retryTimer = null;
        }
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
