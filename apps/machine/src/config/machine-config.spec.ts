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
      machineSecretConfigured: false,
      mqttSigningSecret: null,
      mqttSigningSecretConfigured: false,
      mqttUsername: null,
      mqttPassword: null,
      mqttPasswordConfigured: false,
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      hardwareAdapter: "mock",
      serialPortPath: null,
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
        serialPortPath: " /dev/ttyUSB0 ",
      }),
    ).toMatchObject({
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      serialPortPath: "/dev/ttyUSB0",
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

  it("turns empty serialPortPath into null", () => {
    expect(
      normalizeMachineConfig({ serialPortPath: "   " }).serialPortPath,
    ).toBeNull();
  });

  it("requires serialPortPath for serial adapter", () => {
    expect(() => normalizeMachineConfig({ hardwareAdapter: "serial" })).toThrow(
      /serialPortPath/,
    );
  });

  it("trims machineSecret whitespace", () => {
    expect(
      normalizeMachineConfig({
        machineSecret:
          "  local-machine-shared-secret-change-before-production  ",
      }).machineSecret,
    ).toBe("local-machine-shared-secret-change-before-production");
  });

  it("sets machineSecretConfigured=true when machineSecret is present", () => {
    const result = normalizeMachineConfig({
      machineSecret: "local-machine-shared-secret-change-before-production",
    });
    expect(result.machineSecretConfigured).toBe(true);
  });

  it("sets mqttSigningSecretConfigured=true when mqttSigningSecret is present", () => {
    const result = normalizeMachineConfig({
      mqttSigningSecret:
        "local-machine-shared-secret-change-before-production-xx",
    });
    expect(result.mqttSigningSecretConfigured).toBe(true);
  });

  it("sets mqttPasswordConfigured=true when mqttPassword is present", () => {
    const result = normalizeMachineConfig({
      mqttPassword: "local-machine-shared-secret-change-before-production",
    });
    expect(result.mqttPasswordConfigured).toBe(true);
  });

  it("inherits configured=true from input even when secret is null", () => {
    const result = normalizeMachineConfig({
      machineSecretConfigured: true,
      machineSecret: null,
    });
    expect(result.machineSecretConfigured).toBe(true);
    expect(result.machineSecret).toBeNull();
  });

  it("defaults all configured flags to false when secrets are absent", () => {
    const result = normalizeMachineConfig({});
    expect(result.machineSecretConfigured).toBe(false);
    expect(result.mqttSigningSecretConfigured).toBe(false);
    expect(result.mqttPasswordConfigured).toBe(false);
  });

  it("empty string secret is null and configured remains false", () => {
    const result = normalizeMachineConfig({
      machineSecret: "   ",
    });
    expect(result.machineSecret).toBeNull();
    expect(result.machineSecretConfigured).toBe(false);
  });
});
