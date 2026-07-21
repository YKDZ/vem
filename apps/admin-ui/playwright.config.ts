import { defineConfig, devices } from "@playwright/test";

const chromiumChannel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;

const chromiumUse = {
  ...devices["Desktop Chrome"],
  ...(chromiumChannel ? { channel: chromiumChannel } : {}),
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "pnpm -F admin-ui build && pnpm -F admin-ui exec vite preview --host 0.0.0.0 --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "chromium",
      use: chromiumUse,
    },
  ],
});
