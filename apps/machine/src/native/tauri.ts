import { invoke } from "@tauri-apps/api/core";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function callTauriCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} failed: ${message}`);
  }
}

export async function invokeOptional<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await invoke<T>(command, args);
  } catch {
    return null;
  }
}
