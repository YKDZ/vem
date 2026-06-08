import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonConnectionInfo } from "./daemon-connection";

const mockWindow = (isTauri: boolean): void => {
  vi.stubGlobal(
    "window",
    (isTauri ? { __TAURI_INTERNALS__: {} } : {}) as Window & {
      __TAURI_INTERNALS__?: Record<string, unknown>;
    },
  );
};

describe("daemon connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses browser env and strips trailing slash", async () => {
    vi.stubEnv("VITE_DAEMON_HTTP_BASE_URL", "http://127.0.0.1:7891/");
    vi.stubEnv("VITE_DAEMON_IPC_TOKEN", "dev-token");
    vi.stubEnv("VITE_DAEMON_MOCK", "true");
    vi.stubEnv("VITE_ENABLE_ADVANCED_MAINTENANCE_CONFIG", "true");
    mockWindow(false);
    const info = await getDaemonConnectionInfo();
    expect(info.source).toBe("browser_env");
    expect(info.baseUrl).toBe("http://127.0.0.1:7891");
    expect(info.token).toBe("dev-token");
    expect(typeof info.mock).toBe("boolean");
    expect(info.runtimeFlags?.advancedMaintenanceConfig).toBe(true);
  });

  it("uses tauri command in tauri runtime", async () => {
    const tauriModule = await import("@/native/tauri");
    const commandSpy = vi
      .spyOn(tauriModule, "callTauriCommand")
      .mockResolvedValue({
        baseUrl: "http://127.0.0.1:7891/",
        token: "abc",
        source: "tauri_ready_file",
        mock: true,
        runtimeFlags: {
          advancedMaintenanceConfig: true,
        },
      } as never);

    mockWindow(true);
    const info = await getDaemonConnectionInfo();

    expect(commandSpy).toHaveBeenCalledWith("get_daemon_connection");
    expect(info.baseUrl).toBe("http://127.0.0.1:7891");
    expect(info.source).toBe("tauri_ready_file");
    expect(info.mock).toBe(true);
    expect(info.runtimeFlags?.advancedMaintenanceConfig).toBe(true);
  });

  it("defaults missing tauri runtime flags to disabled", async () => {
    const tauriModule = await import("@/native/tauri");
    vi.spyOn(tauriModule, "callTauriCommand").mockResolvedValue({
      baseUrl: "http://127.0.0.1:7891/",
      token: "abc",
      source: "tauri_ready_file",
      mock: true,
    } as never);

    mockWindow(true);
    const info = await getDaemonConnectionInfo();

    expect(info.runtimeFlags?.advancedMaintenanceConfig).toBe(false);
  });
});
