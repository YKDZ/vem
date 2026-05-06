import { z } from "zod";

import { callTauriCommand, isTauriRuntime } from "./tauri";

export const nativeMqttStatusSchema = z.object({
  running: z.boolean(),
  connected: z.boolean(),
  lastError: z.string().nullable(),
  lastCommandId: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
});

export type NativeMqttStatus = z.infer<typeof nativeMqttStatusSchema>;

export async function startNativeMqttRuntime(): Promise<NativeMqttStatus | null> {
  if (!isTauriRuntime()) return null;
  const result = await callTauriCommand<unknown>("start_native_mqtt_runtime");
  return nativeMqttStatusSchema.parse(result);
}

export async function stopNativeMqttRuntime(): Promise<void> {
  if (!isTauriRuntime()) return;
  await callTauriCommand<void>("stop_native_mqtt_runtime");
}

export async function getNativeMqttStatus(): Promise<NativeMqttStatus | null> {
  if (!isTauriRuntime()) return null;
  const result = await callTauriCommand<unknown>("native_mqtt_status");
  return nativeMqttStatusSchema.parse(result);
}
