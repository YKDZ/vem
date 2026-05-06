import { z } from "zod";

import { callTauriCommand, isTauriRuntime } from "./tauri";

export const localLogStatsSchema = z.object({
  logPath: z.string(),
  totalLines: z.number().int(),
  sizeBytes: z.number().int(),
});

export type LocalLogStats = z.infer<typeof localLogStatsSchema>;

export async function getLocalLogStats(): Promise<LocalLogStats | null> {
  if (!isTauriRuntime()) return null;
  const result = await callTauriCommand<unknown>("get_local_log_stats");
  return localLogStatsSchema.parse(result);
}

export async function exportLocalLogsZip(): Promise<Uint8Array | null> {
  if (!isTauriRuntime()) return null;
  // Returns a Vec<u8> which Tauri serializes as an array of numbers
  const result = await callTauriCommand<number[]>("export_local_logs_zip");
  return new Uint8Array(result);
}
