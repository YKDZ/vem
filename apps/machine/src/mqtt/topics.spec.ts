import { describe, expect, it } from "vitest";

import {
  commandAckTopic,
  dispenseCommandTopic,
  dispenseResultTopic,
  heartbeatTopic,
} from "./topics";

describe("machine mqtt topics", () => {
  it("builds backend-compatible topics", () => {
    expect(dispenseCommandTopic("M001")).toBe(
      "vem/machines/M001/commands/dispense",
    );
    expect(commandAckTopic("M001", "CMD1")).toBe(
      "vem/machines/M001/commands/CMD1/ack",
    );
    expect(dispenseResultTopic("M001")).toBe(
      "vem/machines/M001/events/dispense-result",
    );
    expect(heartbeatTopic("M001")).toBe("vem/machines/M001/events/heartbeat");
  });
});
