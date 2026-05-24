import { z } from "zod";

export const hardwareAdapterSchema = z.enum([
  "mock",
  "serial",
  "bluetooth",
  "vendor_sdk",
]);

export const scannerAdapterSchema = z.enum([
  "disabled",
  "serial_text",
  "keyboard_hid",
  "web_serial_dev",
]);

export const machineConfigSchema = z
  .object({
    machineCode: z.string().trim().min(1).max(64).nullable().default(null),
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
    scannerAdapter: scannerAdapterSchema.default("disabled"),
    scannerSerialPortPath: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .default(null),
    scannerBaudRate: z.int().min(1200).max(921600).default(9600),
    scannerFrameSuffix: z.enum(["crlf", "lf", "cr", "none"]).default("crlf"),
    kioskMode: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.hardwareAdapter === "serial" && !data.serialPortPath) {
      ctx.addIssue({
        code: "custom",
        path: ["serialPortPath"],
        message: "serialPortPath is required when hardwareAdapter=serial",
      });
    }
    if (data.scannerAdapter === "serial_text" && !data.scannerSerialPortPath) {
      ctx.addIssue({
        code: "custom",
        path: ["scannerSerialPortPath"],
        message:
          "scannerSerialPortPath is required when scannerAdapter=serial_text",
      });
    }
  });

export type HardwareAdapter = z.infer<typeof hardwareAdapterSchema>;
export type ScannerAdapter = z.infer<typeof scannerAdapterSchema>;
export type MachineConfig = z.infer<typeof machineConfigSchema>;

export const machineConfigDefaults: MachineConfig = machineConfigSchema.parse(
  {},
);

export function normalizeMachineConfig(input: unknown): MachineConfig {
  const rawObj =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? input
      : {};
  // Merge defaults + input into a plain Record, avoiding unsafe type assertions
  const processed: Record<string, unknown> = {
    ...machineConfigDefaults,
    ...Object.fromEntries(Object.entries(rawObj)),
  };
  // Pre-normalize machineCode: whitespace-only string → null before schema validation
  if (typeof processed.machineCode === "string") {
    const trimmed = processed.machineCode.trim();
    processed.machineCode = trimmed.length > 0 ? trimmed : null;
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
  if (typeof processed.scannerSerialPortPath === "string") {
    const trimmed = processed.scannerSerialPortPath.trim();
    processed.scannerSerialPortPath = trimmed.length > 0 ? trimmed : null;
  }
  const parsed = machineConfigSchema.parse(processed);
  const machineSecret = parsed.machineSecret?.trim() || null;
  const mqttSigningSecret = parsed.mqttSigningSecret?.trim() || null;
  const mqttPassword = parsed.mqttPassword?.trim() || null;
  return {
    ...parsed,
    machineCode: parsed.machineCode?.trim() || null,
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
    scannerSerialPortPath: parsed.scannerSerialPortPath?.trim() || null,
  };
}
