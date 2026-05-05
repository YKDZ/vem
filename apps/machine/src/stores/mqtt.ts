import { heartbeatPayloadSchema, type HeartbeatPayload } from "@vem/shared";
import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";

import { createMockHardwareAdapter } from "@/hardware/mock-adapter";
import { flushOutboxEvents, listOutboxEvents } from "@/local/outbox";
import {
  createMachineMqttClient,
  type MachineMqttClient,
  type MachineMqttStatus,
} from "@/mqtt/client";
import { handleDispenseCommand } from "@/mqtt/handler";
import { dispenseCommandTopic, heartbeatTopic } from "@/mqtt/topics";
import { normalizeMqttWebSocketUrl } from "@/mqtt/url";

import { useConnectivityStore } from "./connectivity";
import { useMachineStore } from "./machine";

type PrivateState = {
  client: MachineMqttClient | null;
  heartbeatTimer: number | null;
};

const privateState: PrivateState = {
  client: null,
  heartbeatTimer: null,
};

export const useMqttStore = defineStore("mqtt", {
  state: () => ({
    status: "disconnected" as MachineMqttStatus,
    clientId: null as string | null,
    connectedUrl: null as string | null,
    lastError: null as string | null,
    lastCommandNo: null as string | null,
    outboxSize: 0,
    lastHeartbeatAt: null as string | null,
  }),
  getters: {
    connected: (state): boolean => state.status === "connected",
  },
  actions: {
    async connect(config: MachineConfig): Promise<void> {
      if (!config.machineCode) throw new Error("machineCode missing");
      if (privateState.client?.isConnected()) return;

      this.disconnect();
      const connectivityStore = useConnectivityStore();
      const url = normalizeMqttWebSocketUrl(config.mqttUrl);
      const clientId = `vem-machine-${config.machineCode}-${crypto.randomUUID()}`;
      this.status = "connecting";
      this.clientId = clientId;
      this.connectedUrl = url;
      this.lastError = null;

      const client = createMachineMqttClient({
        url,
        clientId,
        onStatus: (status, error) => {
          this.status = status;
          this.lastError = error ?? null;
          connectivityStore.setMachineMqttConnected(status === "connected");
        },
      });
      privateState.client = client;

      await client.subscribe(
        dispenseCommandTopic(config.machineCode),
        (_topic, payloadText) => {
          void handleDispenseCommand({
            machineCode: config.machineCode!,
            payloadText,
            publish: async (topic, payload) => client.publish(topic, payload),
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
      await this.flushOutbox();
    },
    disconnect(): void {
      if (privateState.heartbeatTimer)
        window.clearInterval(privateState.heartbeatTimer);
      privateState.heartbeatTimer = null;
      privateState.client?.end();
      privateState.client = null;
      this.status = "disconnected";
      useConnectivityStore().setMachineMqttConnected(false);
    },
    refreshOutboxSize(): void {
      this.outboxSize = listOutboxEvents().length;
    },
    async flushOutbox(): Promise<void> {
      if (!privateState.client?.isConnected()) {
        this.refreshOutboxSize();
        return;
      }
      await flushOutboxEvents(async (topic, payload) =>
        privateState.client!.publish(topic, payload),
      );
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
          localQueueSize: listOutboxEvents().length,
          lastCommandNo: this.lastCommandNo,
        },
      });

      await privateState.client.publish(
        heartbeatTopic(config.machineCode),
        payload,
      );
      this.lastHeartbeatAt = payload.reportedAt;
      await this.flushOutbox();
    },
  },
});
