import { describe, expect, it } from "vitest";

import { normalizeMqttWebSocketUrl } from "./url";

describe("normalizeMqttWebSocketUrl", () => {
  it("keeps websocket URLs unchanged", () => {
    expect(normalizeMqttWebSocketUrl("ws://localhost:9001")).toBe(
      "ws://localhost:9001",
    );
  });

  it("converts local mqtt TCP URL to websocket URL", () => {
    expect(normalizeMqttWebSocketUrl("mqtt://localhost:1883")).toBe(
      "ws://localhost:9001/",
    );
  });

  it("converts mqtts URL to wss URL", () => {
    expect(normalizeMqttWebSocketUrl("mqtts://broker.example.com:8883")).toBe(
      "wss://broker.example.com/",
    );
  });
});
