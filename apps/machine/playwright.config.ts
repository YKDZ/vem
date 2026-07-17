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

function writeEnv(name: string, value: string): void {
  const runtimeProcess = Reflect.get(globalThis, "process");
  if (typeof runtimeProcess !== "object" || runtimeProcess === null) {
    return;
  }
  const env = Reflect.get(runtimeProcess, "env");
  if (typeof env !== "object" || env === null) {
    return;
  }
  Reflect.set(env, name, value);
}

function readArgv(): readonly string[] {
  const runtimeProcess = Reflect.get(globalThis, "process");
  if (typeof runtimeProcess !== "object" || runtimeProcess === null) {
    return [];
  }
  const argv = Reflect.get(runtimeProcess, "argv");
  if (!Array.isArray(argv)) {
    return [];
  }
  return argv.filter((arg): arg is string => typeof arg === "string");
}

function hasExplicitProjectArg(
  argv: readonly string[],
  projectName: string,
): boolean {
  return argv.some((arg, index) => {
    if (arg === `--project=${projectName}`) {
      return true;
    }
    return arg === "--project" && argv[index + 1] === projectName;
  });
}

const isCi = Boolean(readEnv("CI"));
const chromiumChannel = readEnv("PLAYWRIGHT_CHROMIUM_CHANNEL") ?? "chrome";
const touchscreenSmokeTestMatch = /touchscreen-smoke\.spec\.ts/;
const runtimeScreenshotsProjectName = "machine-runtime-screenshots";
const runtimeScreenshotsTestMatch = /machine-runtime-screenshots\.spec\.ts/;
const realDaemonTestMatch = /machine-real-daemon\.spec\.ts/;
const explicitRuntimeScreenshotsProject = hasExplicitProjectArg(
  readArgv(),
  runtimeScreenshotsProjectName,
);
if (explicitRuntimeScreenshotsProject) {
  writeEnv("VEM_MACHINE_RUNTIME_SCREENSHOTS_PROJECT", "1");
}
const includeRuntimeScreenshotsProject =
  readEnv("VEM_MACHINE_RUNTIME_SCREENSHOTS_PROJECT") === "1" ||
  explicitRuntimeScreenshotsProject;

const chromiumUse = {
  ...devices["Desktop Chrome"],
  channel: chromiumChannel,
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: 1,
  hasTouch: true,
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
    },
  },
  projects: [
    {
      name: "machine-runtime-touchscreen",
      testIgnore: [
        touchscreenSmokeTestMatch,
        runtimeScreenshotsTestMatch,
        realDaemonTestMatch,
      ],
      use: chromiumUse,
    },
    {
      name: "machine-touchscreen-smoke",
      testMatch: touchscreenSmokeTestMatch,
      use: chromiumUse,
    },
    ...(includeRuntimeScreenshotsProject
      ? [
          {
            name: runtimeScreenshotsProjectName,
            testMatch: runtimeScreenshotsTestMatch,
            use: chromiumUse,
          },
        ]
      : []),
  ],
});
