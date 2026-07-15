import { describe, expect, it } from "vitest";

import {
  machineConfigDefaults,
  normalizeMachineConfig,
} from "./machine-config";

describe("machine config", () => {
  it("uses first-stage defaults", () => {
    expect(machineConfigDefaults).toEqual({
      machineCode: null,
      machineLocationLabel: null,
      machineSecret: null,
      machineSecretConfigured: false,
      maintenancePinConfigured: false,
      mqttSigningSecret: null,
      mqttSigningSecretConfigured: false,
      mqttUsername: null,
      mqttPassword: null,
      mqttPasswordConfigured: false,
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      hardwareAdapter: "mock",
      serialPortPath: null,
      lowerControllerUsbIdentity: {
        vendorId: "1A86",
        productId: "55D3",
        serialNumber: null,
      },
      scannerAdapter: "disabled",
      scannerSerialPortPath: null,
      scannerUsbIdentity: null,
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf",
      visionEnabled: true,
      visionWsUrl: "ws://127.0.0.1:7892/ws",
      visionRequestTimeoutMs: 8000,
      machineAudioVolume: 0.7,
      machineAudioOutputBinding: null,
      audioCueSettings: {
        enabled: false,
        categories: {
          presence: false,
          transaction: false,
        },
      },
      kioskMode: false,
      stockMovementRetentionDays: 30,
    });
  });

  it("migrates legacy presence audio opt-in into audio cue settings", () => {
    expect(
      normalizeMachineConfig({ presenceAudioEnabled: true }).audioCueSettings,
    ).toEqual({
      enabled: true,
      categories: {
        presence: true,
        transaction: false,
      },
    });
  });

  it("preserves explicit audio cue category settings", () => {
    expect(
      normalizeMachineConfig({
        audioCueSettings: {
          enabled: true,
          categories: {
            presence: false,
            transaction: true,
          },
        },
      }).audioCueSettings,
    ).toEqual({
      enabled: true,
      categories: {
        presence: false,
        transaction: true,
      },
    });
  });

  it("preserves global Machine Audio volume as a normalized value", () => {
    expect(
      normalizeMachineConfig({
        machineAudioVolume: 0.42,
      }).machineAudioVolume,
    ).toBe(0.42);
  });

  it("clamps global Machine Audio volume into the normalized range", () => {
    expect(normalizeMachineConfig({ machineAudioVolume: -0.2 })).toHaveProperty(
      "machineAudioVolume",
      0,
    );
    expect(normalizeMachineConfig({ machineAudioVolume: 1.2 })).toHaveProperty(
      "machineAudioVolume",
      1,
    );
  });

  it("preserves custom stock movement retention days", () => {
    expect(
      normalizeMachineConfig({ stockMovementRetentionDays: 90 })
        .stockMovementRetentionDays,
    ).toBe(90);
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

  it("normalizes optional Machine Location Label", () => {
    expect(
      normalizeMachineConfig({ machineLocationLabel: " E2E lab " })
        .machineLocationLabel,
    ).toBe("E2E lab");
    expect(
      normalizeMachineConfig({ machineLocationLabel: "   " })
        .machineLocationLabel,
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

  it("turns empty scannerSerialPortPath into null", () => {
    expect(
      normalizeMachineConfig({ scannerSerialPortPath: "   " })
        .scannerSerialPortPath,
    ).toBeNull();
  });

  it("normalizes optional vision ws url", () => {
    const result = normalizeMachineConfig({
      visionWsUrl: " ws://127.0.0.1:7892/ws ",
    });
    expect(result.visionWsUrl).toBe("ws://127.0.0.1:7892/ws");
  });

  it("drops legacy machine-owned Virtual Try-On Camera device ids", () => {
    expect(
      normalizeMachineConfig({
        tryOnCameraDeviceId: " camera-device-1 ",
      }),
    ).not.toHaveProperty("tryOnCameraDeviceId");
  });

  it("allows serial adapter with default lower controller USB identity", () => {
    expect(normalizeMachineConfig({ hardwareAdapter: "serial" })).toMatchObject(
      {
        hardwareAdapter: "serial",
        serialPortPath: null,
        lowerControllerUsbIdentity: {
          vendorId: "1A86",
          productId: "55D3",
          serialNumber: null,
        },
      },
    );
  });

  it("rejects unsupported hardware adapter values", () => {
    expect(() =>
      normalizeMachineConfig({ hardwareAdapter: "bluetooth" }),
    ).toThrow();
    expect(() =>
      normalizeMachineConfig({ hardwareAdapter: "vendor_sdk" }),
    ).toThrow();
  });

  it("requires a lower controller USB identity or manual port for serial adapter", () => {
    expect(() =>
      normalizeMachineConfig({
        hardwareAdapter: "serial",
        lowerControllerUsbIdentity: null,
      }),
    ).toThrow(/lowerControllerUsbIdentity/);
  });

  it("normalizes lower controller USB identity", () => {
    expect(
      normalizeMachineConfig({
        lowerControllerUsbIdentity: {
          vendorId: "1a86",
          productId: "55d3",
          serialNumber: "   ",
        },
      }).lowerControllerUsbIdentity,
    ).toEqual({ vendorId: "1A86", productId: "55D3", serialNumber: null });
  });

  it("requires scannerSerialPortPath for serial_text scanner adapter", () => {
    expect(() =>
      normalizeMachineConfig({ scannerAdapter: "serial_text" }),
    ).toThrow(/scannerSerialPortPath/);
  });

  it("rejects unsupported scanner adapter values", () => {
    expect(() =>
      normalizeMachineConfig({ scannerAdapter: "web_serial_dev" }),
    ).toThrow();
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
