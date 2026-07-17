import { defineConfig, devices } from "@playwright/test";

const chromiumChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ?? "chrome";
const daemonHttpBaseUrl =
  process.env.VEM_REAL_DAEMON_HTTP_BASE_URL ?? "http://127.0.0.1:7891";

export default defineConfig({
  testDir: "./tests",
  testMatch: /machine-real-daemon\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 300_000,
  use: {
    baseURL: "http://127.0.0.1:1421",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    channel: chromiumChannel,
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: false,
  },
  webServer: {
    command: "pnpm -F machine exec vite --host 0.0.0.0 --port 1421",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: false,
    env: {
      VITE_DAEMON_HTTP_BASE_URL: daemonHttpBaseUrl,
      VITE_DAEMON_IPC_TOKEN: "dev-token",
      VITE_DAEMON_MOCK: "false",
    },
  },
  projects: [{ name: "machine-real-daemon" }],
});
