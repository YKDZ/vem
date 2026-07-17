import { callTauriCommand, isTauriRuntime } from "./tauri";

export type DaemonConnectionInfo = {
  baseUrl: string;
  token: string;
  source: "tauri_ready_file" | "browser_env";
  mock: boolean;
};

function browserConnection(): DaemonConnectionInfo {
  return {
    baseUrl: String(
      import.meta.env.VITE_DAEMON_HTTP_BASE_URL ?? "http://127.0.0.1:7891",
    ).replace(/\/+$/, ""),
    token: String(import.meta.env.VITE_DAEMON_IPC_TOKEN ?? "dev-token"),
    source: "browser_env",
    mock: import.meta.env.VITE_DAEMON_MOCK === "true",
  };
}

export async function getDaemonConnectionInfo(): Promise<DaemonConnectionInfo> {
  if (!isTauriRuntime()) {
    return browserConnection();
  }

  const info = await callTauriCommand<DaemonConnectionInfo>(
    "get_daemon_connection",
  );
  return {
    ...info,
    baseUrl: info.baseUrl.replace(/\/+$/, ""),
  };
}
