import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  and,
  eq,
  machineCommands,
  machineEvents,
  vendingCommands,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";
import { commandAckPayloadSchema, type CommandAckPayload } from "@vem/shared";
import mqtt, { type MqttClient } from "mqtt";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { lockMachineForVendingMutation } from "../database/machine-transaction-lock";
import { MqttSignatureService } from "./mqtt-signature.service";

type MachineMessageHandler = (topic: string, payload: string) => Promise<void>;
type CommandAckHandler = (
  tx: DrizzleTransaction,
  ack: VerifiedCommandAck,
) => Promise<void>;
type CommandAckDomain = "machine" | "vending";
export type VerifiedCommandAck = {
  machineId: string;
  machineCode: string;
  commandId: string;
  commandNo: string;
  messageId: string;
  payload: CommandAckPayload;
  topic: string;
};
type VendingServiceBinding = {
  handleMachineMessage(topic: string, payload: string): Promise<void>;
};

@Injectable()
export class MqttService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MqttService.name);
  private client?: MqttClient;
  private readonly machineMessageHandlers: MachineMessageHandler[] = [];
  private readonly commandAckHandlers = new Map<
    CommandAckDomain,
    CommandAckHandler
  >();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(MqttSignatureService)
    private readonly mqttSignatureService: MqttSignatureService,
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
      const ackMatch = /^vem\/machines\/([^/]+)\/commands\/([^/]+)\/ack$/.exec(
        topic,
      );
      if (ackMatch) {
        void this.dispatchCommandAck(
          ackMatch[1],
          ackMatch[2],
          topic,
          payloadText,
        ).catch((error: unknown) => {
          this.logger.error(
            `Failed to handle MQTT message ${topic}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
        return;
      }
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

  registerCommandAckHandler(
    domain: CommandAckDomain,
    handler: CommandAckHandler,
  ): void {
    this.commandAckHandlers.set(domain, handler);
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

  private async dispatchCommandAck(
    machineCode: string,
    commandNo: string,
    topic: string,
    payload: string,
  ): Promise<void> {
    let verified: {
      machineId: string;
      machineCode: string;
      messageId: string;
      payload: CommandAckPayload;
    };
    try {
      verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payload),
        payloadSchema: commandAckPayloadSchema,
      });
    } catch {
      this.logger.warn(`Rejected invalid command ACK from ${machineCode}`);
      return;
    }

    await this.db.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, verified.machineId);
      const [vendingCommandsForAck, machineCommandsForAck] = await Promise.all([
        tx
          .select({ id: vendingCommands.id })
          .from(vendingCommands)
          .where(
            and(
              eq(vendingCommands.machineId, verified.machineId),
              eq(vendingCommands.commandNo, commandNo),
            ),
          )
          .limit(2),
        tx
          .select({ id: machineCommands.id })
          .from(machineCommands)
          .where(
            and(
              eq(machineCommands.machineId, verified.machineId),
              eq(machineCommands.commandNo, commandNo),
              eq(machineCommands.type, "environment-control"),
            ),
          )
          .limit(2),
      ]);
      const candidates = [
        ...vendingCommandsForAck.map((command) => ({
          domain: "vending" as const,
          id: command.id,
        })),
        ...machineCommandsForAck.map((command) => ({
          domain: "machine" as const,
          id: command.id,
        })),
      ];
      if (candidates.length !== 1) {
        this.logger.warn(
          `Rejected command ACK ${commandNo} for ${verified.machineCode}: expected exactly one durable command, found ${candidates.length}`,
        );
        return;
      }

      const candidate = candidates[0];
      const handler = this.commandAckHandlers.get(candidate.domain);
      if (!handler) {
        throw new Error(`Missing command ACK handler for ${candidate.domain}`);
      }
      const inserted = await tx
        .insert(machineEvents)
        .values({
          machineId: verified.machineId,
          eventType: "command_ack",
          payloadJson: { ...verified.payload },
          mqttTopic: topic,
          messageId: verified.messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });
      if (inserted.length === 0) return;

      await handler(tx, {
        ...verified,
        commandId: candidate.id,
        commandNo,
        topic,
      });
    });
  }

  private parsePayload(payloadText: string): unknown {
    try {
      const parsed = JSON.parse(payloadText) as unknown;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
