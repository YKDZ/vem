import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import mqtt, { type MqttClient } from "mqtt";

import { AppConfigService } from "../config/app-config.service";

type MachineMessageHandler = (topic: string, payload: string) => Promise<void>;
type VendingServiceBinding = {
  handleMachineMessage(topic: string, payload: string): Promise<void>;
};

@Injectable()
export class MqttService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MqttService.name);
  private client?: MqttClient;
  private readonly machineMessageHandlers: MachineMessageHandler[] = [];

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.client = mqtt.connect(this.config.mqttUrl, {
      clientId: `vem-service-api-${process.pid}`,
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
    });
    this.client.on("connect", () => {
      this.logger.log("MQTT connected");
      this.client?.subscribe("vem/machines/+/commands/+/ack", { qos: 1 });
      this.client?.subscribe("vem/machines/+/events/dispense-result", {
        qos: 1,
      });
      this.client?.subscribe(
        "vem/machines/+/events/environment-control-result",
        { qos: 1 },
      );
      this.client?.subscribe(
        "vem/machines/+/events/secure-decommission-result",
        { qos: 1 },
      );
      this.client?.subscribe("vem/machines/+/events/heartbeat", { qos: 1 });
    });
    this.client.on("message", (topic, payload) => {
      const payloadText = payload.toString("utf8");
      for (const handler of this.machineMessageHandlers) {
        void handler(topic, payloadText).catch((error: unknown) => {
          this.logger.error(
            `Failed to handle MQTT message ${topic}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
      }
    });
    this.client.on("error", (error) => {
      this.logger.warn(`MQTT error: ${error.message}`);
    });
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    if (!this.client) {
      return Promise.reject(new Error("MQTT client is not initialized"));
    }
    return new Promise((resolve, reject) => {
      this.client?.publish(
        topic,
        JSON.stringify(payload),
        { qos: 1 },
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
  }

  registerMachineMessageHandler(handler: MachineMessageHandler): void {
    this.machineMessageHandlers.push(handler);
  }

  bindVendingService(vendingService: VendingServiceBinding): void {
    this.registerMachineMessageHandler(async (topic, payload) => {
      await vendingService.handleMachineMessage(topic, payload);
    });
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  onApplicationShutdown(): void {
    this.client?.end(true);
  }
}
