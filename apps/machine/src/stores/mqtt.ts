import { heartbeatPayloadSchema, type HeartbeatPayload } from "@vem/shared";
import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";

import { createMockHardwareAdapter } from "@/hardware/mock-adapter";
import { flushOutboxEvents, getOutboxStats } from "@/local/outbox";
import {
  createMachineMqttClient,
  type MachineMqttClient,
  type MachineMqttStatus,
} from "@/mqtt/client";
import { handleDispenseCommand } from "@/mqtt/handler";
import { signMqttEnvelope } from "@/mqtt/signature";
import { dispenseCommandTopic, heartbeatTopic } from "@/mqtt/topics";
import { normalizeMqttWebSocketUrl } from "@/mqtt/url";
import {
  getNativeMqttStatus,
  startNativeMqttRuntime,
  stopNativeMqttRuntime,
} from "@/native/mqtt-runtime";
import { isTauriRuntime } from "@/native/tauri";

import { useConnectivityStore } from "./connectivity";
import { useMachineStore } from "./machine";

type PrivateState = {
  client: MachineMqttClient | null;
  heartbeatTimer: number | null;
  machineCode: string | null;
  mqttSigningSecret: string | null;
  nativeMode: boolean;
  nativeStatusTimer: number | null;
};

const privateState: PrivateState = {
  client: null,
  heartbeatTimer: null,
  machineCode: null,
  mqttSigningSecret: null,
  nativeMode: false,
  nativeStatusTimer: null,
};

export const useMqttStore = defineStore("mqtt", {
  state: () => ({
    status: "disconnected" as MachineMqttStatus,
    clientId: null as string | null,
    connectedUrl: null as string | null,
    lastError: null as string | null,
    lastCommandNo: null as string | null,
    outboxSize: 0,
    outboxUsageRatio: 0,
    outboxWarning: null as string | null,
    lastHeartbeatAt: null as string | null,
  }),
  getters: {
    connected: (state): boolean => state.status === "connected",
  },
  actions: {
    async connect(config: MachineConfig): Promise<void> {
      if (!config.machineCode) throw new Error("machineCode missing");

      // If running in Tauri, prefer native MQTT runtime
      if (isTauriRuntime()) {
        await this.connectNative();
        return;
      }

      if (privateState.client?.isConnected()) return;

      this.disconnect();
      const connectivityStore = useConnectivityStore();
      const url = normalizeMqttWebSocketUrl(config.mqttUrl);
      // Use a stable clientId (not random UUID) so the broker can track sessions
      const clientId = `vem-machine-${config.machineCode}`;
      this.status = "connecting";
      this.clientId = clientId;
      this.connectedUrl = url;
      this.lastError = null;

      // Persist signing credentials to private state so they survive secret cleanup
      privateState.machineCode = config.machineCode;
      privateState.mqttSigningSecret = config.mqttSigningSecret ?? null;

      const client = createMachineMqttClient({
        url,
        clientId,
        username: config.mqttUsername ?? undefined,
        password: config.mqttPassword ?? undefined,
        onStatus: (status, error) => {
          this.status = status;
          this.lastError = error ?? null;
          connectivityStore.setMachineMqttConnected(status === "connected");
        },
      });
      privateState.client = client;

      // Helper to sign and publish; throws if signing credentials are missing
      const publishSigned = async (
        topic: string,
        payload: unknown,
        messageId: string,
      ) => {
        if (!config.machineCode || !config.mqttSigningSecret) {
          throw new Error("MQTT signing credential missing");
        }
        const envelope = await signMqttEnvelope({
          machineCode: config.machineCode,
          signingSecret: config.mqttSigningSecret,
          payload,
          messageId,
        });
        await client.publish(topic, envelope);
      };

      await client.subscribe(
        dispenseCommandTopic(config.machineCode),
        (_topic, payloadText) => {
          void handleDispenseCommand({
            machineCode: config.machineCode!,
            signingSecret: config.mqttSigningSecret ?? undefined,
            payloadText,
            publish: publishSigned,
            adapter: createMockHardwareAdapter(globalThis.localStorage),
          })
            .then((result) => {
              this.lastCommandNo = result.commandNo;
              this.refreshOutboxSize();
            })
            .catch((error: unknown) => {
              this.lastError =
                error instanceof Error ? error.message : String(error);
            });
        },
      );

      this.startHeartbeat(config);
      await this.flushOutbox(config);
    },
    disconnect(): void {
      if (privateState.heartbeatTimer)
        window.clearInterval(privateState.heartbeatTimer);
      privateState.heartbeatTimer = null;
      if (privateState.nativeStatusTimer)
        window.clearInterval(privateState.nativeStatusTimer);
      privateState.nativeStatusTimer = null;
      if (privateState.nativeMode) {
        void stopNativeMqttRuntime().catch((_err: unknown) => {
          /* ignore shutdown errors */
        });
        privateState.nativeMode = false;
      }
      privateState.client?.end();
      privateState.client = null;
      this.status = "disconnected";
      useConnectivityStore().setMachineMqttConnected(false);
    },
    async connectNative(): Promise<void> {
      this.status = "connecting";
      this.lastError = null;
      try {
        const nativeStatus = await startNativeMqttRuntime();
        if (nativeStatus) {
          privateState.nativeMode = true;
          this.status = nativeStatus.connected ? "connected" : "connecting";
          this.lastError = nativeStatus.lastError;
          this.lastCommandNo = nativeStatus.lastCommandNo;
          // Poll native status every 5 seconds
          if (!privateState.nativeStatusTimer) {
            privateState.nativeStatusTimer = window.setInterval(() => {
              void getNativeMqttStatus().then((s) => {
                if (!s) return;
                this.status = s.connected ? "connected" : "disconnected";
                this.lastError = s.lastError;
                this.lastCommandNo = s.lastCommandNo;
                this.lastHeartbeatAt = s.lastHeartbeatAt;
                useConnectivityStore().setMachineMqttConnected(s.connected);
              });
            }, 5000);
          }
        }
      } catch (error) {
        this.status = "error" as MachineMqttStatus;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    },
    refreshOutboxSize(): void {
      const stats = getOutboxStats();
      this.outboxSize = stats.size;
      this.outboxUsageRatio = stats.usageRatio;
      this.outboxWarning =
        stats.usageRatio >= 0.9
          ? `本地补发队列已使用 ${stats.size}/${stats.max}，请检查网络或联系运维`
          : null;
    },
    async flushOutbox(config?: MachineConfig): Promise<void> {
      const machineCode = config?.machineCode ?? privateState.machineCode;
      const signingSecret =
        config?.mqttSigningSecret ?? privateState.mqttSigningSecret;

      if (!privateState.client?.isConnected()) {
        this.refreshOutboxSize();
        return;
      }
      if (!machineCode || !signingSecret) {
        this.lastError = "MQTT signing credential missing; skip outbox flush";
        this.refreshOutboxSize();
        return;
      }
      // Re-sign each outbox event on flush so signatures are always fresh
      await flushOutboxEvents(async (topic, payload, eventId) => {
        const envelope = await signMqttEnvelope({
          machineCode,
          signingSecret,
          payload,
          messageId: eventId,
        });
        await privateState.client!.publish(topic, envelope);
      });
      this.refreshOutboxSize();
    },
    startHeartbeat(config: MachineConfig): void {
      if (!config.machineCode) return;
      if (privateState.heartbeatTimer)
        window.clearInterval(privateState.heartbeatTimer);
      const send = () => void this.publishHeartbeat(config);
      send();
      privateState.heartbeatTimer = window.setInterval(send, 30_000);
    },
    async publishHeartbeat(config: MachineConfig): Promise<void> {
      if (!config.machineCode || !privateState.client?.isConnected()) return;
      const machineStore = useMachineStore();
      const payload: HeartbeatPayload = heartbeatPayloadSchema.parse({
        machineCode: config.machineCode,
        reportedAt: new Date().toISOString(),
        statusPayload: {
          appVersion: "0.1.0",
          network: "online",
          mqttConnected: true,
          hardwareAdapter: config.hardwareAdapter,
          hardwareStatus: machineStore.hardwareReady ? "ok" : "degraded",
          localQueueSize: getOutboxStats().size,
          lastCommandNo: this.lastCommandNo,
        },
      });

      const messageId = `heartbeat:${crypto.randomUUID()}`;
      if (config.mqttSigningSecret) {
        const envelope = await signMqttEnvelope({
          machineCode: config.machineCode,
          signingSecret: config.mqttSigningSecret,
          payload,
          messageId,
        });
        await privateState.client.publish(
          heartbeatTopic(config.machineCode),
          envelope,
        );
      } else {
        await privateState.client.publish(
          heartbeatTopic(config.machineCode),
          payload,
        );
      }
      this.lastHeartbeatAt = payload.reportedAt;
      await this.flushOutbox(config);
    },
  },
});
