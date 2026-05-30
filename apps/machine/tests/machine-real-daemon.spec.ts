import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DaemonProcess = {
  kill(signal?: string): boolean;
};

let daemon: DaemonProcess | null = null;
let dataDir = "";

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vem-real-daemon-"));
  await writeFile(join(dataDir, "ipc-token"), "dev-token");
  await writeFile(
    join(dataDir, "machine-config.json"),
    JSON.stringify({
      machineCode: "MACHINE-UI",
      apiBaseUrl: "http://127.0.0.1:9/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      mqttUsername: null,
      hardwareAdapter: "mock",
      serialPortPath: null,
      scannerAdapter: "disabled",
      scannerSerialPortPath: null,
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf",
      visionEnabled: false,
      visionWsUrl: "ws://127.0.0.1:7892/ws",
      visionAutoStart: false,
      visionProcessCommand: null,
      visionProcessArgs: null,
      visionRequestTimeoutMs: 8000,
      kioskMode: false,
    }),
  );
  daemon = spawn("cargo", [
    "run",
    "-p",
    "vending-daemon",
    "--",
    "--console",
    "--data-dir",
    dataDir,
    "--bind",
    "127.0.0.1:7891",
  ]);
  await expect(async () => {
    const ready = JSON.parse(
      await readFile(join(dataDir, "daemon-ready.json"), "utf8"),
    ) as { ipcToken?: unknown };
    expect(ready.ipcToken).toBeTruthy();
  }).toPass({
    intervals: [100],
    timeout: 10_000,
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
    page.getByRole("heading", { name: /暂时无法购买|请选择商品|部署配置/ }),
  ).toBeVisible();
  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/(offline|catalog|maintenance)$/);
});
