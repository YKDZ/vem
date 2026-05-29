import { defineConfig, devices } from "@playwright/test";

const chromiumUse = {
  ...devices["Desktop Chrome"],
  ...(process.env.CI ? { channel: "chrome" as const } : {}),
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
  projects: [
    {
      name: "chromium",
      use: chromiumUse,
    },
  ],
});
