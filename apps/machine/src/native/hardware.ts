import { z } from "zod";

import { callTauriCommand, isTauriRuntime } from "./tauri";

const hardwareAdapterSchema = z.enum(["mock", "serial"]);
export const hardwareStatusSchema = z.enum(["ok", "degraded"]);

export const hardwareSelfCheckResultSchema = z.object({
  adapter: hardwareAdapterSchema,
  status: hardwareStatusSchema,
  message: z.string(),
  checkedAtMs: z.number().nonnegative(),
});

export type HardwareSelfCheckResult = z.infer<
  typeof hardwareSelfCheckResultSchema
>;

export async function hardwareSelfCheck(): Promise<HardwareSelfCheckResult> {
  if (!isTauriRuntime()) {
    return {
      adapter: "mock",
      status: "ok",
      message: "mock adapter ready (browser dev fallback)",
      checkedAtMs: Date.now(),
    };
  }

  const result = await callTauriCommand<unknown>("hardware_self_check");
  return hardwareSelfCheckResultSchema.parse(result);
}
