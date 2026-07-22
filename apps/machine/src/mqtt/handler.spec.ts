import type { DispenseCommandPayload } from "@vem/shared";

import { describe, expect, it } from "vitest";

import type { HardwareAdapter } from "@/hardware/adapter";
import type { StorageLike } from "@/local/command-log";

import { getCommandLogEntry } from "@/local/command-log";
import { listOutboxEvents } from "@/local/outbox";

import { handleDispenseCommand } from "./handler";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

const command = {
  commandNo: "CMD1",
  orderNo: "ORD1",
  slot: {
    rowNo: 1,
    cellNo: 1,
  },
  quantity: 1,
  timeoutSeconds: 120,
};

describe("handleDispenseCommand", () => {
  it("acks, dispenses, logs and publishes result", async () => {
    const storage = memoryStorage();
    const published: Array<{ topic: string; payload: unknown }> = [];
    const dispensed: DispenseCommandPayload[] = [];
    const adapter: HardwareAdapter = {
      async dispense(dispenseCommand) {
        dispensed.push(dispenseCommand);
        return {
          commandNo: "CMD1",
          success: true,
          errorCode: null,
          message: "ok",
          reportedAt: "2026-05-05T12:00:00.000Z",
          rawResponse: {},
          startedAt: "2026-05-05T12:00:00.000Z",
          finishedAt: "2026-05-05T12:00:00.000Z",
        };
      },
    };

    const result = await handleDispenseCommand({
      machineCode: "M001",
      payloadText: JSON.stringify(command),
      adapter,
      storage,
      publish: async (topic, payload) => {
        published.push({ topic, payload });
      },
    });

    expect(result.duplicated).toBe(false);
    expect(published.map((item) => item.topic)).toEqual([
      "vem/machines/M001/commands/CMD1/ack",
      "vem/machines/M001/events/dispense-result",
    ]);
    expect(getCommandLogEntry("CMD1", storage)?.resultPayload?.success).toBe(
      true,
    );
    expect(dispensed).toHaveLength(1);
    expect(dispensed[0].slot).toEqual({ rowNo: 1, cellNo: 1 });
  });

  it("does not dispense twice for duplicate command with saved result", async () => {
    const storage = memoryStorage();
    let dispenseCount = 0;
    const adapter: HardwareAdapter = {
      async dispense() {
        dispenseCount += 1;
        return {
          commandNo: "CMD1",
          success: true,
          errorCode: null,
          message: "ok",
          reportedAt: "2026-05-05T12:00:00.000Z",
          rawResponse: {},
          startedAt: "2026-05-05T12:00:00.000Z",
          finishedAt: "2026-05-05T12:00:00.000Z",
        };
      },
    };

    const base = {
      machineCode: "M001",
      payloadText: JSON.stringify(command),
      adapter,
      storage,
      publish: async () => undefined,
    };
    await handleDispenseCommand(base);
    const duplicate = await handleDispenseCommand(base);

    expect(duplicate.duplicated).toBe(true);
    expect(dispenseCount).toBe(1);
  });

  it("puts ack and result into outbox when publish fails", async () => {
    const storage = memoryStorage();
    const adapter: HardwareAdapter = {
      async dispense() {
        return {
          commandNo: "CMD1",
          success: false,
          errorCode: "JAMMED",
          message: "mock jammed",
          reportedAt: "2026-05-05T12:00:00.000Z",
          rawResponse: {},
          startedAt: "2026-05-05T12:00:00.000Z",
          finishedAt: "2026-05-05T12:00:00.000Z",
        };
      },
    };

    await handleDispenseCommand({
      machineCode: "M001",
      payloadText: JSON.stringify(command),
      adapter,
      storage,
      publish: async () => {
        throw new Error("offline");
      },
    });

    expect(listOutboxEvents(storage).map((event) => event.kind)).toEqual([
      "command_ack",
      "dispense_result",
    ]);
  });
});
