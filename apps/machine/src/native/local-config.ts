import {
  machineConfigDefaults,
  normalizeMachineConfig,
  type MachineConfig,
} from "@/config/machine-config";

import { callTauriCommand, isTauriRuntime } from "./tauri";

const BROWSER_CONFIG_KEY = "vem.machine.config.public";

let browserRuntimeSecrets: Pick<
  MachineConfig,
  "machineSecret" | "mqttSigningSecret" | "mqttPassword"
> = {
  machineSecret: null,
  mqttSigningSecret: null,
  mqttPassword: null,
};

function readBrowserPublicConfig(): MachineConfig {
  if (typeof localStorage === "undefined") return machineConfigDefaults;
  const raw = localStorage.getItem(BROWSER_CONFIG_KEY);
  if (!raw) return machineConfigDefaults;
  try {
    return normalizeMachineConfig(JSON.parse(raw));
  } catch {
    localStorage.removeItem(BROWSER_CONFIG_KEY);
    return machineConfigDefaults;
  }
}

function writeBrowserPublicConfig(config: MachineConfig): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(BROWSER_CONFIG_KEY, JSON.stringify(config));
}

function readBrowserConfig(includeSecrets: boolean): MachineConfig {
  const publicConfig = readBrowserPublicConfig();
  return normalizeMachineConfig({
    ...publicConfig,
    ...(includeSecrets ? browserRuntimeSecrets : {}),
  });
}

function writeBrowserConfig(config: MachineConfig): MachineConfig {
  const normalized = normalizeMachineConfig(config);
  browserRuntimeSecrets = {
    machineSecret:
      normalized.machineSecret ?? browserRuntimeSecrets.machineSecret,
    mqttSigningSecret:
      normalized.mqttSigningSecret ?? browserRuntimeSecrets.mqttSigningSecret,
    mqttPassword: normalized.mqttPassword ?? browserRuntimeSecrets.mqttPassword,
  };
  writeBrowserPublicConfig({
    ...normalized,
    machineSecret: null,
    mqttSigningSecret: null,
    mqttPassword: null,
  });
  return readBrowserConfig(false);
}

export async function getMachineConfig(): Promise<MachineConfig> {
  if (!isTauriRuntime()) return readBrowserConfig(false);
  const config = await callTauriCommand<unknown>("get_machine_config");
  return normalizeMachineConfig(config);
}

export async function getMachineRuntimeConfig(): Promise<MachineConfig> {
  if (!isTauriRuntime()) return readBrowserConfig(true);
  const config = await callTauriCommand<unknown>("get_machine_runtime_config");
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
