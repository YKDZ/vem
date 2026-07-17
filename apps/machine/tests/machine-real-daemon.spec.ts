import { test, expect } from "@playwright/test";
import { effectiveMachineRuntimeConfigurationSchema } from "@vem/shared";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  healthSnapshotSchema,
  readySnapshotSchema,
  transactionSnapshotSchema,
} from "../src/daemon/schemas";

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
let provisioningServer: Server | null = null;
let provisioningBaseUrl = "";

type DaemonReadyFile = {
  healthzUrl: string;
  readyzUrl: string;
  ipcToken: string;
  generation: string;
};

const DAEMON_START_TIMEOUT_MS = 300_000;
const DAEMON_HTTP_BASE_URL =
  process.env.VEM_REAL_DAEMON_HTTP_BASE_URL ?? "http://127.0.0.1:7891";
const DAEMON_BIND_ADDRESS = new URL(DAEMON_HTTP_BASE_URL).host;
const REPOSITORY_ROOT = new URL("../../..", import.meta.url).pathname;
const DAEMON_BINARY = join(
  REPOSITORY_ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "vending-daemon.exe" : "vending-daemon",
);

test.setTimeout(DAEMON_START_TIMEOUT_MS);

function recordDaemonOutput(source: string, chunk: unknown): void {
  daemonOutput.push(`[${source}] ${String(chunk)}`);
  daemonOutput = daemonOutput.slice(-120);
}

function formatDaemonOutput(): string {
  if (daemonOutput.length === 0) return "daemon output is empty";
  return daemonOutput.join("").trim();
}

async function readDaemonBootEndpoint(path: string): Promise<unknown> {
  const response = await fetch(`${DAEMON_HTTP_BASE_URL}${path}`, {
    headers: { Authorization: "Bearer dev-token" },
  });
  const body = await response.text();
  expect(response.ok, `${path} returned HTTP ${response.status}: ${body}`).toBe(
    true,
  );
  return JSON.parse(body) as unknown;
}

async function readDaemonReadyFile(): Promise<DaemonReadyFile> {
  return JSON.parse(
    await readFile(join(dataDir, "daemon-ready.json"), "utf8"),
  ) as DaemonReadyFile;
}

async function browserUsesRealDaemon(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { getDaemonConnectionInfo } = await import(
      "/src/native/daemon-connection.ts"
    );
    return (await getDaemonConnectionInfo()).mock === false;
  });
}

async function startBrowserEventStreamProbe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(async () => {
    const { daemonClient } = await import("/src/daemon/client.ts");
    const records: string[] = [];
    const subscription = daemonClient.subscribeEvents({
      onEvent: () => undefined,
      onError: () => records.push("error"),
      onStale: () => records.push("stale"),
      onOpen: ({ reconnected }) =>
        records.push(reconnected ? "opened:reconnected" : "opened:initial"),
      onReconnect: () => records.push("reconnected"),
    });
    Reflect.set(window, "__vemRealDaemonEventStream", records);
    Reflect.set(window, "__vemRealDaemonEventSubscription", subscription);
  });
}

async function browserEventStreamLifecycle(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(() => {
    const records = Reflect.get(window, "__vemRealDaemonEventStream");
    return Array.isArray(records)
      ? records.filter((record): record is string => typeof record === "string")
      : [];
  });
}

async function buildDaemonBinary(): Promise<void> {
  const build = spawn("cargo", ["build", "-p", "vending-daemon"], {
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
  });
  let output = "";
  build.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  build.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    build.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (result.code !== 0) {
    throw new Error(
      `build vending-daemon failed code=${result.code} signal=${result.signal}\n${output}`,
    );
  }
}

function startDaemonProcess(): void {
  daemon = spawn(
    DAEMON_BINARY,
    ["--console", "--data-dir", dataDir, "--bind", DAEMON_BIND_ADDRESS],
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
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(DAEMON_START_TIMEOUT_MS);
  await buildDaemonBinary();
  runtimeRoot = await mkdtemp(join(tmpdir(), "vem-real-daemon-"));
  dataDir = join(runtimeRoot, "vending-daemon");
  await mkdir(dataDir, { recursive: true });
  daemonOutput = [];
  await writeFile(join(dataDir, "ipc-token"), "dev-token");
  provisioningServer = createServer((request, response) => {
    if (
      request.method === "POST" &&
      request.url === "/api/machine-auth/token"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accessToken: "real-daemon-test-token" }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/api/machine-orders/payment-options"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          options: [
            {
              optionKey: "qr_code:alipay",
              providerCode: "alipay",
              method: "qr_code",
              displayName: "支付宝扫码",
              description: "请使用支付宝扫码支付",
              icon: "alipay",
              recommended: true,
              disabled: false,
              disabledReason: null,
            },
          ],
          defaultOptionKey: "qr_code:alipay",
          defaultProviderCode: "alipay",
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/machines/claim") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        machine: {
          id: "550e8400-e29b-41d4-a716-446655440001",
          code: "REAL-DAEMON-001",
          name: "Real Daemon Test",
          status: "online",
          locationLabel: "test lab",
        },
        credentials: {
          machineSecret: "machine-secret-0123456789-0123456789",
          machineSecretVersion: 1,
          mqttSigningSecret: "mqtt-signing-secret-0123456789-0123456789",
          mqttConnection: {
            url: "mqtt://127.0.0.1:1883",
            clientId: "real-daemon-test",
            username: "machine",
            password: "mqtt-password",
          },
        },
        apiBaseUrl: provisioningBaseUrl,
        runtimeEndpoints: {
          apiBasePath: "/api",
          machineAuthTokenPath: "/api/machine-auth/token",
          machineApiBasePath: "/api/machines/REAL-DAEMON-001",
          mqttTopicPrefix: "vem/machines/REAL-DAEMON-001",
        },
        hardwareProfile: {
          profile: "production",
          controller: { required: true, protocol: "vem-vending-controller" },
          paymentScanner: { required: true, supportsPaymentCode: true },
          vision: { required: false, supportsRecommendations: true },
        },
        hardwareModel: "vem-prod-24",
        hardwareSlotTopology: { identity: "vem-prod-24", version: "v1" },
        paymentCapability: {
          profile: "production",
          qrCodeEnabled: true,
          paymentCodeEnabled: true,
          serverTime: "2026-07-17T08:00:00.000Z",
        },
        metadata: {
          profileVersion: 1,
          profileRevision: 1,
          claimCodeId: "550e8400-e29b-41d4-a716-446655440002",
          claimedAt: "2026-07-17T08:00:00.000Z",
          serverTime: "2026-07-17T08:00:00.000Z",
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    provisioningServer?.once("error", reject);
    provisioningServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = provisioningServer.address();
  if (!address || typeof address === "string") {
    throw new Error("provisioning test server did not allocate a TCP port");
  }
  provisioningBaseUrl = `http://127.0.0.1:${address.port}/api`;
  await writeFile(
    join(runtimeRoot, "runtime-bootstrap.json"),
    JSON.stringify({
      schemaVersion: 1,
      provisioningApiBaseUrl: provisioningBaseUrl,
      hardwareModel: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "v1" },
    }),
  );
  startDaemonProcess();
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
  if (provisioningServer) {
    await new Promise<void>((resolve, reject) => {
      provisioningServer?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
});

test("real daemon claim survives its supervised reconfigure cycle and reaches catalog", async ({
  page,
}) => {
  await page.goto("/#/boot");
  await expect.poll(() => browserUsesRealDaemon(page)).toBe(true);
  await startBrowserEventStreamProbe(page);
  await expect.poll(async () =>
    (await browserEventStreamLifecycle(page)).includes("opened:initial"),
  ).toBe(true);
  await expect(page).toHaveURL(/#\/maintenance$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "生产维护" })).toBeVisible();
  await expect(page.getByLabel("认领码")).toBeVisible();

  const readyBeforeClaim = await readDaemonReadyFile();
  await page.getByLabel("认领码").fill("REAL-0001");
  await page.getByRole("button", { name: "认领机器" }).click();
  await expect(page.getByText("REAL-DAEMON-001")).toBeVisible({
    timeout: 20_000,
  });
  await expect(async () => {
    expect((await readDaemonReadyFile()).generation).not.toBe(
      readyBeforeClaim.generation,
    );
  }).toPass({ intervals: [100, 250, 500], timeout: 20_000 });
  await expect.poll(async () =>
    (await browserEventStreamLifecycle(page)).includes("stale"),
  ).toBe(true);
  await expect.poll(async () =>
    (await browserEventStreamLifecycle(page)).includes("opened:reconnected"),
  ).toBe(true);
  const streamLifecycle = await browserEventStreamLifecycle(page);
  expect(streamLifecycle.indexOf("stale")).toBeGreaterThanOrEqual(0);
  expect(streamLifecycle.indexOf("opened:reconnected")).toBeGreaterThan(
    streamLifecycle.indexOf("stale"),
  );
  await expect(async () => {
    const response = await fetch(
      `${DAEMON_HTTP_BASE_URL}/v1/runtime-configuration`,
      {
        headers: { Authorization: "Bearer dev-token" },
      },
    );
    expect(response.ok).toBe(true);
    const configuration = (await response.json()) as {
      machine?: { code?: unknown } | null;
      sourceDocuments?: { profileCache?: unknown };
    };
    expect(configuration.machine?.code).toBe("REAL-DAEMON-001");
    expect(typeof configuration.sourceDocuments?.profileCache).toBe("object");
  }).toPass({ intervals: [250, 500, 1000], timeout: 20_000 });

  const [health, ready, transaction, saleStartCapability, configuration] =
    await Promise.all([
      readDaemonBootEndpoint("/healthz"),
      readDaemonBootEndpoint("/readyz"),
      readDaemonBootEndpoint("/v1/transactions/current"),
      readDaemonBootEndpoint("/v1/sale-start-capability"),
      readDaemonBootEndpoint("/v1/runtime-configuration"),
    ]);
  healthSnapshotSchema.parse(health);
  readySnapshotSchema.parse(ready);
  transactionSnapshotSchema.parse(transaction);
  expect(saleStartCapability).toMatchObject({
    generation: expect.any(String),
    revision: expect.any(Number),
    canStartSale: expect.any(Boolean),
  });
  effectiveMachineRuntimeConfigurationSchema.parse(configuration);

  await expect(page).toHaveURL(/#\/maintenance$/);
  await page.getByRole("button", { name: "回到目录" }).click();
  await expect(page).toHaveURL(/#\/catalog$/, { timeout: 20_000 });
});
