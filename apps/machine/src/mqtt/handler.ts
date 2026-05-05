import {
  commandAckPayloadSchema,
  dispenseCommandPayloadSchema,
  dispenseResultPayloadSchema,
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

import { commandAckTopic, dispenseResultTopic } from "./topics";

type Publish = (topic: string, payload: unknown) => Promise<void>;

async function publishOrEnqueue(input: {
  kind: "command_ack" | "dispense_result";
  id: string;
  topic: string;
  payload: unknown;
  publish: Publish;
  storage: StorageLike;
}): Promise<void> {
  try {
    await input.publish(input.topic, input.payload);
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
  payloadText: string;
  publish: Publish;
  adapter: HardwareAdapter;
  storage?: StorageLike;
}): Promise<{ commandNo: string; duplicated: boolean }> {
  const storage = input.storage ?? globalThis.localStorage;
  const command = dispenseCommandPayloadSchema.parse(
    JSON.parse(input.payloadText),
  );
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
