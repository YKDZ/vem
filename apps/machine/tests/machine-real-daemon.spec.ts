import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
let runtimeRoot = "";
let dataDir = "";
let daemonOutput: string[] = [];
let daemonExit: Promise<void> | null = null;

const DAEMON_START_TIMEOUT_MS = 300_000;
const DAEMON_HTTP_BASE_URL = "http://127.0.0.1:7891";

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
  runtimeRoot = await mkdtemp(join(tmpdir(), "vem-real-daemon-"));
  dataDir = join(runtimeRoot, "vending-daemon");
  await mkdir(dataDir, { recursive: true });
  daemonOutput = [];
  await writeFile(join(dataDir, "ipc-token"), "dev-token");
  await writeFile(
    join(runtimeRoot, "runtime-bootstrap.json"),
    JSON.stringify({
      schemaVersion: 1,
      provisioningApiBaseUrl: "http://127.0.0.1:9/api",
      hardwareModel: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "v1" },
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
        VEM_DAEMON_SECRET_STORE: "file",
      },
    },
  );
  daemonExit = new Promise((resolve) => {
    daemon?.on("exit", () => {
      resolve();
    });
  });
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
  await expect(async () => {
    const response = await fetch(
      `${DAEMON_HTTP_BASE_URL}/v1/runtime-configuration`,
      {
        headers: { Authorization: "Bearer dev-token" },
      },
    ).catch((error: unknown) => {
      throw new Error(
        `daemon HTTP config check failed: ${
          error instanceof Error ? error.message : String(error)
        }\n${formatDaemonOutput()}`,
      );
    });
    expect(response.ok).toBe(true);
    const configuration = (await response.json()) as {
      sourceDocuments?: { bootstrap?: unknown; profileCache?: unknown };
      machine?: unknown;
      profileRefresh?: { status?: unknown };
    };
    expect(typeof configuration.sourceDocuments?.bootstrap).toBe("object");
    expect(configuration.sourceDocuments?.profileCache).toBeNull();
    expect(configuration.machine).toBeNull();
    expect(configuration.profileRefresh?.status).toBe("unclaimed");
  }).toPass({
    intervals: [250, 500, 1000],
    timeout: DAEMON_START_TIMEOUT_MS - 10_000,
  });
});

test.afterAll(async () => {
  if (daemon) {
    daemon.kill("SIGTERM");
    const stopped = await Promise.race([
      daemonExit?.then(() => true) ?? Promise.resolve(true),
      new Promise<false>((resolve) =>
        setTimeout(() => {
          resolve(false);
        }, 5_000),
      ),
    ]);
    if (!stopped) {
      daemon.kill("SIGKILL");
      await Promise.race([
        daemonExit ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
});

test("browser UI routes using real daemon ready snapshots", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: /首次部署控制台|暂时无法购买|设备离线|生产维护|请选择商品类别/,
    }),
  ).toBeVisible();
  await page.close();

  const bootPage = await context.newPage();
  await bootPage.goto("/#/boot");
  await expect(bootPage).toHaveURL(
    /#\/(bring-up|offline|catalog|maintenance)$/,
    {
      timeout: 20_000,
    },
  );
});
