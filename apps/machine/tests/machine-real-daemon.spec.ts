import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DaemonProcess = {
  kill(signal?: string): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): void };
  stdout: { on(event: "data", listener: (chunk: unknown) => void): void };
};

let daemon: DaemonProcess | null = null;
let dataDir = "";
let daemonOutput: string[] = [];

const DAEMON_START_TIMEOUT_MS = 300_000;

test.setTimeout(DAEMON_START_TIMEOUT_MS);

function recordDaemonOutput(source: string, chunk: unknown): void {
  daemonOutput.push(`[${source}] ${String(chunk)}`);
  daemonOutput = daemonOutput.slice(-120);
}

function formatDaemonOutput(): string {
  if (daemonOutput.length === 0) return "daemon output is empty";
  return daemonOutput.join("").trim();
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(DAEMON_START_TIMEOUT_MS);
  dataDir = await mkdtemp(join(tmpdir(), "vem-real-daemon-"));
  daemonOutput = [];
  await writeFile(join(dataDir, "ipc-token"), "dev-token");
  await writeFile(
    join(dataDir, "machine-config.json"),
    JSON.stringify({
      machineId: "550e8400-e29b-41d4-a716-446655440099",
      machineCode: "MACHINE-UI",
      machineName: "Machine UI E2E",
      machineStatus: "online",
      machineLocationText: "E2E lab",
      apiBaseUrl: "http://127.0.0.1:9/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      mqttUsername: null,
      mqttClientId: "vem-machine-MACHINE-UI",
      hardwareAdapter: "mock",
      serialPortPath: null,
      scannerAdapter: "disabled",
      scannerSerialPortPath: null,
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf",
      visionEnabled: false,
      visionWsUrl: "ws://127.0.0.1:7892/ws",
      visionRequestTimeoutMs: 8000,
      kioskMode: false,
      runtimeEndpoints: {
        apiBasePath: "/api",
        machineAuthTokenPath: "/api/machine-auth/token",
        machineApiBasePath: "/api/machines/MACHINE-UI",
        mqttTopicPrefix: "vem/machines/MACHINE-UI",
      },
    }),
  );
  daemon = spawn(
    "cargo",
    [
      "run",
      "-p",
      "vending-daemon",
      "--",
      "--console",
      "--data-dir",
      dataDir,
      "--bind",
      "127.0.0.1:7891",
    ],
    {
      env: {
        ...process.env,
        CARGO_TERM_COLOR: "never",
        VEM_DAEMON_SECRET_STORE: "env",
        VEM_MACHINE_SECRET: "machine-secret-for-machine-ui-e2e",
        VEM_MQTT_SIGNING_SECRET: "mqtt-signing-secret-for-machine-ui-e2e",
        VEM_MQTT_PASSWORD: "mqtt-password-for-machine-ui-e2e",
      },
    },
  );
  daemon.stdout.on("data", (chunk) => {
    recordDaemonOutput("stdout", chunk);
  });
  daemon.stderr.on("data", (chunk) => {
    recordDaemonOutput("stderr", chunk);
  });
  daemon.on("exit", (code, signal) => {
    recordDaemonOutput("process", `exited code=${code} signal=${signal}\n`);
  });
  await expect(async () => {
    const readyPath = join(dataDir, "daemon-ready.json");
    try {
      const ready = JSON.parse(await readFile(readyPath, "utf8")) as {
        ipcToken?: unknown;
      };
      expect(ready.ipcToken).toBeTruthy();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `daemon did not write ${readyPath}: ${message}\n${formatDaemonOutput()}`,
      );
    }
  }).toPass({
    intervals: [250, 500, 1000],
    timeout: DAEMON_START_TIMEOUT_MS - 10_000,
  });
});

test.afterAll(async () => {
  daemon?.kill("SIGTERM");
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("browser UI routes using real daemon ready snapshots", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /暂时无法购买|唐诗村|生产维护/ }),
  ).toBeVisible();
  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/(offline|catalog|maintenance)$/);
});
