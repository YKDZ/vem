import {
  commandAckPayloadSchema,
  dispenseCommandPayloadSchema,
  dispenseResultPayloadSchema,
  mqttSignedEnvelopeSchema,
  type DispenseCommandPayload,
  type DispenseResultPayload,
} from "@vem/shared";

import type { HardwareAdapter } from "@/hardware/adapter";

import { toDispenseResultPayload } from "@/hardware/adapter";
import {
  getCommandLogEntry,
  isCommandInActiveWindow,
  markCommandResult,
  markCommandStatus,
  type StorageLike,
} from "@/local/command-log";
import { enqueueOutboxEvent } from "@/local/outbox";

import { verifyMqttEnvelope } from "./signature";
import { commandAckTopic, dispenseResultTopic } from "./topics";

/** publish(topic, payload, messageId) — re-signed on each call */
type Publish = (
  topic: string,
  payload: unknown,
  messageId: string,
) => Promise<void>;

async function publishOrEnqueue(input: {
  kind: "command_ack" | "dispense_result";
  id: string;
  topic: string;
  payload: unknown;
  publish: Publish;
  storage: StorageLike;
}): Promise<void> {
  try {
    await input.publish(input.topic, input.payload, input.id);
  } catch {
    enqueueOutboxEvent(input, input.storage);
  }
}

function timeoutResult(command: DispenseCommandPayload): DispenseResultPayload {
  return dispenseResultPayloadSchema.parse({
    commandNo: command.commandNo,
    success: false,
    errorCode: "MOTOR_TIMEOUT",
    message: "command exceeded local active window",
    reportedAt: new Date().toISOString(),
  });
}

export async function handleDispenseCommand(input: {
  machineCode: string;
  signingSecret?: string;
  payloadText: string;
  publish: Publish;
  adapter: HardwareAdapter;
  storage?: StorageLike;
}): Promise<{ commandNo: string; duplicated: boolean }> {
  const storage = input.storage ?? globalThis.localStorage;

  // Parse raw payload — may be a signed envelope or a plain command
  const rawParsed: unknown = JSON.parse(input.payloadText);

  let command: DispenseCommandPayload;
  if (input.signingSecret) {
    // Verify signed envelope from backend
    const envelopeParseResult = mqttSignedEnvelopeSchema.safeParse(rawParsed);
    if (!envelopeParseResult.success) {
      throw new Error("Invalid dispense command: not a signed envelope");
    }
    const envelope = await verifyMqttEnvelope({
      envelope: envelopeParseResult.data,
      signingSecret: input.signingSecret,
    });
    if (envelope.machineCode !== input.machineCode) {
      throw new Error(
        `machineCode mismatch: topic=${input.machineCode} envelope=${envelope.machineCode}`,
      );
    }
    command = dispenseCommandPayloadSchema.parse(envelope.payload);
  } else {
    command = dispenseCommandPayloadSchema.parse(rawParsed);
  }
  const existing = getCommandLogEntry(command.commandNo, storage);

  const ackPayload = commandAckPayloadSchema.parse({
    messageId: `ack:${command.commandNo}`,
  });
  await publishOrEnqueue({
    kind: "command_ack",
    id: `ack:${command.commandNo}`,
    topic: commandAckTopic(input.machineCode, command.commandNo),
    payload: ackPayload,
    publish: input.publish,
    storage,
  });

  if (existing?.resultPayload) {
    await publishOrEnqueue({
      kind: "dispense_result",
      id: `result:${command.commandNo}`,
      topic: dispenseResultTopic(input.machineCode),
      payload: existing.resultPayload,
      publish: input.publish,
      storage,
    });
    return { commandNo: command.commandNo, duplicated: true };
  }

  if (existing && isCommandInActiveWindow(existing, Date.now())) {
    return { commandNo: command.commandNo, duplicated: true };
  }

  if (existing?.status === "dispensing") {
    const resultPayload = timeoutResult(command);
    markCommandResult(command, resultPayload, storage);
    await publishOrEnqueue({
      kind: "dispense_result",
      id: `result:${command.commandNo}`,
      topic: dispenseResultTopic(input.machineCode),
      payload: resultPayload,
      publish: input.publish,
      storage,
    });
    return { commandNo: command.commandNo, duplicated: true };
  }

  markCommandStatus(command, "dispensing", storage);
  const hardwareResult = await input.adapter.dispense(command);
  const resultPayload = dispenseResultPayloadSchema.parse(
    toDispenseResultPayload(hardwareResult),
  );
  markCommandResult(command, resultPayload, storage);

  await publishOrEnqueue({
    kind: "dispense_result",
    id: `result:${command.commandNo}`,
    topic: dispenseResultTopic(input.machineCode),
    payload: resultPayload,
    publish: input.publish,
    storage,
  });

  return { commandNo: command.commandNo, duplicated: false };
}
