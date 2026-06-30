import {
  getDaemonConnectionInfo,
  type DaemonConnectionInfo,
} from "@/native/daemon-connection";

import {
  catalogSnapshotSchema,
  configSummarySchema,
  daemonEventSchema,
  hardwareSelfCheckSchema,
  healthSnapshotSchema,
  machinePaymentOptionsResponseSchema,
  machineSaleReadinessSchema,
  naturalContextSnapshotSchema,
  readySnapshotSchema,
  remoteOpsStatusSchema,
  machineSaleViewSnapshotSchema,
  provisioningClaimResponseSchema,
  scannerStatusSchema,
  syncStatusSchema,
  transactionSnapshotSchema,
  visionStatusSchema,
  type CatalogSnapshot,
  type ConfigSummary,
  type DaemonEvent,
  type HealthSnapshot,
  type HardwareSelfCheck,
  type MachineSaleReadiness,
  type NaturalContextSnapshot,
  type ProvisioningClaimResponse,
  type ReadySnapshot,
  type RemoteOpsStatus,
  type SaleViewSnapshot,
  type ScannerStatus,
  type SyncStatus,
  type TransactionSnapshot,
  type VisionStatus,
} from "./schemas";

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
};

type Subscription = {
  close(): void;
};

const MAX_SEEN_EVENT_IDS = 1000;

export class DaemonApiClient {
  private connection: DaemonConnectionInfo | null = null;
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventIdQueue: string[] = [];

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
    }).catch((error: unknown) => {
      throw new DaemonUnavailableError("daemon request failed", error);
    });

    if (response.status === 401 && options.retry401 !== false) {
      await this.initialize(true);
      return this.request(path, { ...options, retry401: false });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
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
      const statusMessage = `${path} returned HTTP ${response.status}`;
      throw new DaemonUnavailableError(
        responseMessage
          ? `${responseMessage} (${statusMessage})`
          : statusMessage,
        undefined,
        {
          statusCode: response.status,
          responseCode,
          responseMessage,
          responseBody: text.slice(0, 2_000),
        },
      );
    }

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed;
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

  async getConfig(): Promise<ConfigSummary> {
    return configSummarySchema.parse(await this.request("/v1/config"));
  }

  async saveConfig(body: unknown): Promise<ConfigSummary> {
    return configSummarySchema.parse(
      await this.request("/v1/config", {
        method: "PUT",
        body,
      }),
    );
  }

  async claimMachine(claimCode: string): Promise<ProvisioningClaimResponse> {
    return provisioningClaimResponseSchema.parse(
      await this.request("/v1/provisioning/claim", {
        method: "POST",
        body: { claimCode },
      }),
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
    return machineSaleViewSnapshotSchema.parse(
      await this.request("/v1/sale-view"),
    );
  }

  async recordStockMovement(body: unknown): Promise<SaleViewSnapshot> {
    return machineSaleViewSnapshotSchema.parse(
      await this.request("/v1/stock/movements", {
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
        handlers.onStale();
        window.setTimeout(() => {
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
