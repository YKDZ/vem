import { DEFAULT_VISION_WS_URL } from "@vem/shared";
import { z } from "zod";

export const hardwareAdapterSchema = z.enum(["mock", "serial"]);

export const scannerAdapterSchema = z.enum(["disabled", "serial_text"]);

export const audioCueSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  categories: z
    .object({
      presence: z.boolean().default(false),
      transaction: z.boolean().default(false),
    })
    .default({
      presence: false,
      transaction: false,
    }),
});

const audioCueSettingsDefaults = {
  enabled: false,
  categories: {
    presence: false,
    transaction: false,
  },
};

const usbHexIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{4}$/, "must be a 4-character hexadecimal USB id")
  .transform((value) => value.toUpperCase());

export const lowerControllerUsbIdentitySchema = z
  .object({
    vendorId: usbHexIdSchema,
    productId: usbHexIdSchema,
    serialNumber: z.string().trim().min(1).max(128).nullable().default(null),
  })
  .nullable();

export const machineConfigSchema = z
  .object({
    machineCode: z.string().trim().min(1).max(64).nullable().default(null),
    machineLocationLabel: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .default(null),
    machineSecret: z.string().trim().min(32).max(256).nullable().default(null),
    machineSecretConfigured: z.boolean().default(false),
    mqttSigningSecret: z
      .string()
      .trim()
      .min(32)
      .max(256)
      .nullable()
      .default(null),
    mqttSigningSecretConfigured: z.boolean().default(false),
    mqttUsername: z.string().trim().min(1).max(128).nullable().default(null),
    mqttPassword: z.string().trim().min(1).max(256).nullable().default(null),
    mqttPasswordConfigured: z.boolean().default(false),
    apiBaseUrl: z
      .string()
      .trim()
      .pipe(z.url())
      .default("http://localhost:3000/api"),
    mqttUrl: z.string().trim().min(1).default("mqtt://localhost:1883"),
    hardwareAdapter: hardwareAdapterSchema.default("mock"),
    serialPortPath: z.string().trim().min(1).max(256).nullable().default(null),
    lowerControllerUsbIdentity: lowerControllerUsbIdentitySchema.default({
      vendorId: "1A86",
      productId: "55D3",
      serialNumber: null,
    }),
    scannerAdapter: scannerAdapterSchema.default("disabled"),
    scannerSerialPortPath: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .default(null),
    scannerUsbIdentity: lowerControllerUsbIdentitySchema
      .nullable()
      .default(null),
    scannerBaudRate: z.int().min(1200).max(921600).default(9600),
    scannerFrameSuffix: z.enum(["crlf", "lf", "cr", "none"]).default("crlf"),
    visionEnabled: z.boolean().default(true),
    visionWsUrl: z.string().trim().pipe(z.url()).default(DEFAULT_VISION_WS_URL),
    visionRequestTimeoutMs: z.int().min(1000).max(30_000).default(8000),
    tryOnCameraDeviceId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .nullable()
      .default(null),
    audioCueSettings: audioCueSettingsSchema.default(audioCueSettingsDefaults),
    kioskMode: z.boolean().default(false),
    stockMovementRetentionDays: z.int().min(1).max(366).default(30),
  })
  .superRefine((data, ctx) => {
    if (
      data.hardwareAdapter === "serial" &&
      !data.serialPortPath &&
      !data.lowerControllerUsbIdentity
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["lowerControllerUsbIdentity"],
        message:
          "lowerControllerUsbIdentity or serialPortPath is required when hardwareAdapter=serial",
      });
    }
    if (
      data.scannerAdapter === "serial_text" &&
      !data.scannerSerialPortPath &&
      !data.scannerUsbIdentity
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scannerSerialPortPath"],
        message:
          "scannerSerialPortPath or scannerUsbIdentity is required when scannerAdapter=serial_text",
      });
    }
  });

export type HardwareAdapter = z.infer<typeof hardwareAdapterSchema>;
export type ScannerAdapter = z.infer<typeof scannerAdapterSchema>;
export type AudioCueSettings = z.infer<typeof audioCueSettingsSchema>;
export type MachineConfig = z.infer<typeof machineConfigSchema>;

export const machineConfigDefaults: MachineConfig = machineConfigSchema.parse(
  {},
);

export function normalizeMachineConfig(input: unknown): MachineConfig {
  const rawObj =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? input
      : {};
  const rawRecord = Object.fromEntries(Object.entries(rawObj));
  // Merge defaults + input into a plain Record, avoiding unsafe type assertions
  const processed: Record<string, unknown> = {
    ...machineConfigDefaults,
    ...rawRecord,
  };
  if (
    !("audioCueSettings" in rawRecord) &&
    typeof processed.presenceAudioEnabled === "boolean"
  ) {
    processed.audioCueSettings = {
      enabled: processed.presenceAudioEnabled,
      categories: {
        presence: processed.presenceAudioEnabled,
        transaction: false,
      },
    };
  }
  delete processed.presenceAudioEnabled;
  // Pre-normalize machineCode: whitespace-only string → null before schema validation
  if (typeof processed.machineCode === "string") {
    const trimmed = processed.machineCode.trim();
    processed.machineCode = trimmed.length > 0 ? trimmed : null;
  }
  if (typeof processed.machineLocationLabel === "string") {
    const trimmed = processed.machineLocationLabel.trim();
    processed.machineLocationLabel = trimmed.length > 0 ? trimmed : null;
  }
  // Pre-normalize machineSecret: whitespace-only string → null before schema validation
  if (typeof processed.machineSecret === "string") {
    const trimmed = processed.machineSecret.trim();
    processed.machineSecret = trimmed.length > 0 ? trimmed : null;
  }
  // Pre-normalize mqttSigningSecret
  if (typeof processed.mqttSigningSecret === "string") {
    const trimmed = processed.mqttSigningSecret.trim();
    processed.mqttSigningSecret = trimmed.length > 0 ? trimmed : null;
  }
  // Pre-normalize mqttUsername
  if (typeof processed.mqttUsername === "string") {
    const trimmed = processed.mqttUsername.trim();
    processed.mqttUsername = trimmed.length > 0 ? trimmed : null;
  }
  // Pre-normalize mqttPassword
  if (typeof processed.mqttPassword === "string") {
    const trimmed = processed.mqttPassword.trim();
    processed.mqttPassword = trimmed.length > 0 ? trimmed : null;
  }
  // Pre-normalize serialPortPath
  if (typeof processed.serialPortPath === "string") {
    const trimmed = processed.serialPortPath.trim();
    processed.serialPortPath = trimmed.length > 0 ? trimmed : null;
  }
  if (isPlainRecord(processed.lowerControllerUsbIdentity)) {
    const identity = processed.lowerControllerUsbIdentity;
    if (typeof identity.serialNumber === "string") {
      const trimmed = identity.serialNumber.trim();
      identity.serialNumber = trimmed.length > 0 ? trimmed : null;
    }
    processed.lowerControllerUsbIdentity = identity;
  }
  if (typeof processed.scannerSerialPortPath === "string") {
    const trimmed = processed.scannerSerialPortPath.trim();
    processed.scannerSerialPortPath = trimmed.length > 0 ? trimmed : null;
  }
  if (typeof processed.visionWsUrl === "string") {
    processed.visionWsUrl = processed.visionWsUrl.trim();
  }
  if (typeof processed.tryOnCameraDeviceId === "string") {
    const trimmed = processed.tryOnCameraDeviceId.trim();
    processed.tryOnCameraDeviceId = trimmed.length > 0 ? trimmed : null;
  }
  const parsed = machineConfigSchema.parse(processed);
  const machineSecret = parsed.machineSecret?.trim() || null;
  const mqttSigningSecret = parsed.mqttSigningSecret?.trim() || null;
  const mqttPassword = parsed.mqttPassword?.trim() || null;
  return {
    ...parsed,
    machineCode: parsed.machineCode?.trim() || null,
    machineLocationLabel: parsed.machineLocationLabel?.trim() || null,
    machineSecret,
    machineSecretConfigured: Boolean(
      machineSecret || parsed.machineSecretConfigured,
    ),
    mqttSigningSecret,
    mqttSigningSecretConfigured: Boolean(
      mqttSigningSecret || parsed.mqttSigningSecretConfigured,
    ),
    mqttUsername: parsed.mqttUsername?.trim() || null,
    mqttPassword,
    mqttPasswordConfigured: Boolean(
      mqttPassword || parsed.mqttPasswordConfigured,
    ),
    apiBaseUrl: parsed.apiBaseUrl.replace(/\/+$/, ""),
    mqttUrl: parsed.mqttUrl.trim(),
    serialPortPath: parsed.serialPortPath?.trim() || null,
    lowerControllerUsbIdentity: parsed.lowerControllerUsbIdentity,
    scannerUsbIdentity: parsed.scannerUsbIdentity,
    scannerSerialPortPath: parsed.scannerSerialPortPath?.trim() || null,
    visionWsUrl: parsed.visionWsUrl.trim(),
    tryOnCameraDeviceId: parsed.tryOnCameraDeviceId?.trim() || null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
