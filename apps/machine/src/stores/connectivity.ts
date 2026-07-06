import { defineStore } from "pinia";

import type {
  HealthSnapshot,
  MachineSaleReadiness,
  ReadySnapshot,
  UnknownDaemonEvent,
} from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export type UnknownDaemonEventDiagnostic = {
  type: string;
  eventId: string;
  updatedAt: string;
  recordedAt: string;
  metadata: unknown | null;
  diagnostics: unknown | null;
  diagnostic: unknown | null;
};

type ConnectivityState = {
  health: HealthSnapshot | null;
  ready: ReadySnapshot | null;
  saleReadiness: MachineSaleReadiness | null;
  latestUnknownEventDiagnostic: UnknownDaemonEventDiagnostic | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  lastCheckedAt: string | null;
};

export const useConnectivityStore = defineStore("connectivity", {
  state: (): ConnectivityState => ({
    health: null,
    ready: null,
    saleReadiness: null,
    latestUnknownEventDiagnostic: null,
    loading: false,
    stale: false,
    error: null,
    lastCheckedAt: null,
  }),
  getters: {
    networkLabel: (state): string => {
      if (state.loading) return "检测中";
      if (!state.health) return "未连接";
      if (!state.health.backendOnline) return "后端离线";
      if (!state.health.mqttConnected) return "MQTT 未就绪";
      return "在线";
    },
    blockingReasons: (state): string[] =>
      state.ready?.blockingReasons.map((reason) => reason.message) ?? [],
    degradedReasons: (state): string[] =>
      state.ready?.degradedReasons.map((reason) => reason.message) ?? [],
    saleReadinessBlockingMessages: (state): string[] => {
      const components = state.saleReadiness?.components;
      if (!components) return [];
      const blockingCodes = new Set(state.saleReadiness?.blockingCodes ?? []);
      return [
        components.platformReachability,
        components.machineAuthentication,
        components.activePlanogram,
        components.paymentOptions,
        components.syncHealth,
        components.wholeMachineBlockers,
        components.productionDispensePath,
        components.slotSaleSafety,
      ]
        .filter((component): component is NonNullable<typeof component> =>
          Boolean(component),
        )
        .filter(
          (component) => !component.ready && blockingCodes.has(component.code),
        )
        .map((component) => component.message);
    },
    saleReadinessDegradedMessages: (state): string[] => {
      const components = state.saleReadiness?.components;
      if (!components) return [];

      const paymentCode = components.paymentOptions.methods.find(
        (method) => method.method === "payment_code",
      );
      const readyAlternative = components.paymentOptions.methods.some(
        (method) => method.method !== "payment_code" && method.ready,
      );
      if (
        components.scannerCapability.ready ||
        !paymentCode ||
        paymentCode.ready
      ) {
        return [];
      }

      const rawReason =
        paymentCode.disabledReason ?? components.scannerCapability.message;
      const scannerReason = rawReason.startsWith("扫码器不可用")
        ? rawReason
        : `扫码器不可用：${rawReason}`;
      return [
        readyAlternative
          ? `${scannerReason}；付款码支付不可用，二维码支付仍可用。`
          : `${scannerReason}；付款码支付不可用。`,
      ];
    },
    isSaleNetworkReady: (state): boolean =>
      Boolean(
        !state.stale &&
        state.saleReadiness?.canStartNetworkAuthorizedSale &&
        state.ready?.canSell &&
        state.health?.configConfigured,
      ),
  },
  actions: {
    applyHealth(snapshot: HealthSnapshot): void {
      this.health = snapshot;
      this.lastCheckedAt = snapshot.updatedAt;
      this.error = null;
      this.stale = false;
    },
    applyReady(snapshot: ReadySnapshot): void {
      this.ready = snapshot;
      this.error = null;
      this.stale = false;
    },
    applySaleReadiness(snapshot: MachineSaleReadiness): void {
      this.saleReadiness = snapshot;
      this.error = null;
      this.stale = false;
    },
    async refresh(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const [health, ready, saleReadiness] = await Promise.all([
          daemonClient.getHealth(),
          daemonClient.getReady(),
          daemonClient.getSaleReadiness(),
        ]);
        this.applyHealth(health);
        this.applyReady(ready);
        this.applySaleReadiness(saleReadiness);
      } catch (error) {
        this.stale = true;
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    markStale(error?: unknown): void {
      this.stale = true;
      this.error =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "daemon events disconnected";
    },
    recordUnknownEvent(event: UnknownDaemonEvent): void {
      const eventRecord = event as Record<string, unknown>;
      this.latestUnknownEventDiagnostic = {
        type: event.type,
        eventId: event.eventId,
        updatedAt: event.updatedAt,
        recordedAt: new Date().toISOString(),
        metadata: eventRecord.metadata ?? null,
        diagnostics: eventRecord.diagnostics ?? null,
        diagnostic: eventRecord.diagnostic ?? null,
      };
    },
  },
});
