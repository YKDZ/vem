import {
  machineConfigDefaults,
  normalizeMachineConfig,
  type MachineConfig,
} from "@/config/machine-config";

import { callTauriCommand, isTauriRuntime } from "./tauri";

const BROWSER_CONFIG_KEY = "vem.machine.config";

function readBrowserConfig(): MachineConfig {
  if (typeof localStorage === "undefined") return machineConfigDefaults;

  const raw = localStorage.getItem(BROWSER_CONFIG_KEY);
  if (!raw) return machineConfigDefaults;

  try {
    return normalizeMachineConfig(JSON.parse(raw));
  } catch {
    return machineConfigDefaults;
  }
}

function writeBrowserConfig(config: MachineConfig): MachineConfig {
  const normalized = normalizeMachineConfig(config);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(BROWSER_CONFIG_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export async function getMachineConfig(): Promise<MachineConfig> {
  if (!isTauriRuntime()) return readBrowserConfig();

  const config = await callTauriCommand<unknown>("get_machine_config");
  return normalizeMachineConfig(config);
}

export async function saveMachineConfig(
  config: MachineConfig,
): Promise<MachineConfig> {
  if (!isTauriRuntime()) return writeBrowserConfig(config);

  const saved = await callTauriCommand<unknown>("save_machine_config", {
    config,
  });
  return normalizeMachineConfig(saved);
}
