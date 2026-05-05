import { z } from "zod";

export const hardwareAdapterSchema = z.enum([
  "mock",
  "serial",
  "bluetooth",
  "vendor_sdk",
]);

export const machineConfigSchema = z.object({
  machineCode: z.string().trim().min(1).max(64).nullable().default(null),
  apiBaseUrl: z
    .string()
    .trim()
    .pipe(z.url())
    .default("http://localhost:3000/api"),
  mqttUrl: z.string().trim().min(1).default("mqtt://localhost:1883"),
  hardwareAdapter: hardwareAdapterSchema.default("mock"),
  kioskMode: z.boolean().default(false),
});

export type HardwareAdapter = z.infer<typeof hardwareAdapterSchema>;
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
  const parsed = machineConfigSchema.parse(processed);
  return {
    ...parsed,
    machineCode: parsed.machineCode?.trim() || null,
    apiBaseUrl: parsed.apiBaseUrl.replace(/\/+$/, ""),
    mqttUrl: parsed.mqttUrl.trim(),
  };
}
