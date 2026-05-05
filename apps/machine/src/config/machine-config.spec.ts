import { describe, expect, it } from "vitest";

import {
  machineConfigDefaults,
  normalizeMachineConfig,
} from "./machine-config";

describe("machine config", () => {
  it("uses first-stage defaults", () => {
    expect(machineConfigDefaults).toEqual({
      machineCode: null,
      machineSecret: null,
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      hardwareAdapter: "mock",
      kioskMode: false,
    });
  });

  it("normalizes whitespace and trailing slashes", () => {
    expect(
      normalizeMachineConfig({
        machineCode: " M001 ",
        apiBaseUrl: "http://localhost:3000/api///",
        mqttUrl: " mqtt://localhost:1883 ",
        hardwareAdapter: "mock",
      }),
    ).toMatchObject({
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
    });
  });

  it("turns empty machineCode into null", () => {
    expect(
      normalizeMachineConfig({ machineCode: "   " }).machineCode,
    ).toBeNull();
  });

  it("turns empty machineSecret into null", () => {
    expect(
      normalizeMachineConfig({ machineSecret: "   " }).machineSecret,
    ).toBeNull();
  });

  it("trims machineSecret whitespace", () => {
    expect(
      normalizeMachineConfig({
        machineSecret:
          "  local-machine-shared-secret-change-before-production  ",
      }).machineSecret,
    ).toBe("local-machine-shared-secret-change-before-production");
  });
});
