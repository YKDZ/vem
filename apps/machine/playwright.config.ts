import { defineConfig, devices } from "@playwright/test";

function readEnv(name: string): string | undefined {
  const runtimeProcess = Reflect.get(globalThis, "process");
  if (typeof runtimeProcess !== "object" || runtimeProcess === null) {
    return undefined;
  }
  const env = Reflect.get(runtimeProcess, "env");
  if (typeof env !== "object" || env === null) {
    return undefined;
  }
  const value = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}

const isCi = Boolean(readEnv("CI"));
const chromiumChannel = readEnv("PLAYWRIGHT_CHROMIUM_CHANNEL") ?? "chrome";

const chromiumUse = {
  ...devices["Desktop Chrome"],
  channel: chromiumChannel,
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: 1,
  isMobile: false,
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: isCi,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm -F machine dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !isCi,
    env: {
      VITE_DAEMON_HTTP_BASE_URL: "http://127.0.0.1:7891",
      VITE_DAEMON_IPC_TOKEN: "dev-token",
      VITE_DAEMON_MOCK: "true",
      VITE_ENABLE_MOCK_PAYMENT_CONTROLS: "true",
    },
  },
  projects: [
    {
      name: "chromium",
      use: chromiumUse,
    },
  ],
});
