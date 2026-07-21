#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const localContainers = new Set();
const localProcesses = new Set();
const JOBS = new Set(["static", "unit", "admin-e2e", "rust"]);
const CARGO_TYPIFY_VERSION = "cargo-typify 0.7.0";

const serviceApiEnv = {
  JWT_SECRET: "ci-jwt-secret-at-least-32-characters-long!",
  JWT_REFRESH_SECRET: "ci-jwt-refresh-secret-minimum-32-chars!!",
  MACHINE_JWT_SECRET: "ci-machine-jwt-secret-min-32-chars-long!",
  MACHINE_CREDENTIAL_ENCRYPTION_KEY: "ci-machine-cred-enc-key-32-chars!!",
  MQTT_URL: "mqtt://localhost:1883",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_WEBHOOK_BASE_URL: "http://localhost:3000",
  BOOTSTRAP_ADMIN_PASSWORD: "AdminPassword123!",
};

function printStep(name) {
  console.log(`\n==> ${name}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}`,
        ),
      );
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}${
                message ? `\n${message}` : ""
              }`,
        ),
      );
    });
  });
}

async function commandAvailable(command, args = ["--version"]) {
  try {
    await capture(command, args);
    return true;
  } catch {
    return false;
  }
}

async function requireCommand(command, args = ["--version"]) {
  if (await commandAvailable(command, args)) {
    return;
  }
  throw new Error(
    `Missing required command: ${command}. Install it before running pnpm check.`,
  );
}

async function cargoTypifyVersion() {
  try {
    const { stdout } = await capture("cargo", ["typify", "--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function ensureCargoTypify() {
  const actual = await cargoTypifyVersion();
  if (actual === CARGO_TYPIFY_VERSION) {
    return;
  }

  printStep(`Install ${CARGO_TYPIFY_VERSION}`);
  await run("cargo", [
    "install",
    "cargo-typify",
    "--version",
    "0.7.0",
    "--locked",
    "--force",
  ]);

  const installed = await cargoTypifyVersion();
  if (installed !== CARGO_TYPIFY_VERSION) {
    throw new Error(
      `Expected ${CARGO_TYPIFY_VERSION}, but cargo typify reports ${installed ?? "unavailable"}.`,
    );
  }
}

async function assertLocalCiPrerequisites() {
  printStep("Check local CI prerequisites");
  await requireCommand("docker");
  await requireCommand("google-chrome");
}

async function assertDockerPrerequisite() {
  printStep("Check Docker prerequisite");
  await requireCommand("docker");
}

async function assertChromePrerequisite() {
  printStep("Check Chrome prerequisite");
  await requireCommand("google-chrome");
}

async function dockerRm(name) {
  try {
    await run("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // The container may not exist; docker rm -f is only cleanup best effort.
  } finally {
    localContainers.delete(name);
  }
}

async function startPostgres(name, database) {
  await dockerRm(name);
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_DB=${database}`,
    "-e",
    "POSTGRES_USER=vem",
    "-e",
    "POSTGRES_PASSWORD=vem_password",
    "-p",
    "127.0.0.1::5432",
    "--health-cmd",
    `pg_isready -U vem -d ${database}`,
    "--health-interval",
    "5s",
    "--health-timeout",
    "3s",
    "--health-retries",
    "20",
    "postgres:16",
  ]);
  localContainers.add(name);
  await waitForPostgres(name);
  return resolvePublishedDockerEndpoint(name, 5432);
}

async function waitForPostgres(name) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const { stdout } = await capture("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      name,
    ]);
    if (stdout.trim() === "healthy") {
      return;
    }
    await sleep(2000);
  }
  await run("docker", ["logs", name]);
  throw new Error(`Timed out waiting for ${name} to become healthy.`);
}

async function startMosquitto(name, directory) {
  await dockerRm(name);
  await mkdir(directory, { recursive: true });
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::1883",
    "--entrypoint",
    "sh",
    "eclipse-mosquitto:2",
    "-c",
    [
      "printf 'listener 1883 0.0.0.0\\nallow_anonymous true\\n' > /tmp/mosquitto-ci.conf",
      "exec /usr/sbin/mosquitto -c /tmp/mosquitto-ci.conf",
    ].join(" && "),
  ]);
  localContainers.add(name);
  const endpoint = await resolvePublishedDockerEndpoint(name, 1883);
  await waitForTcp(endpoint.host, endpoint.port, name);
  return endpoint;
}

async function resolvePublishedDockerEndpoint(containerName, containerPort) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const { stdout } = await capture("docker", [
      "port",
      containerName,
      `${containerPort}/tcp`,
    ]);
    const published = stdout.trim().split("\n")[0];
    const separator = published.lastIndexOf(":");
    const port = Number(published.slice(separator + 1));
    if (Number.isInteger(port) && port > 0) {
      if (await canConnect("127.0.0.1", port)) {
        return { host: "127.0.0.1", port };
      }
      const { stdout: containerAddress } = await capture("docker", [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        containerName,
      ]);
      const host = containerAddress.trim();
      if (host !== "") {
        return { host, port: containerPort };
      }
    }
    await sleep(1000);
  }

  throw new Error(
    `Cannot resolve published port ${containerPort} for ${containerName}.`,
  );
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function waitForTcp(host, port, label) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (await canConnect(host, port)) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label} at ${host}:${port}.`);
}

function startProcess(command, args, options = {}) {
  const out = createWriteStream(join(root, options.logPath), { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  localProcesses.add(child);
  child.on("exit", () => {
    localProcesses.delete(child);
    out.end();
  });
  child.on("error", (error) => {
    console.error(error.message);
  });
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForUrl(url, label, logPath) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is ready or the timeout expires.
    }
    await sleep(2000);
  }

  console.error(`${label} did not become ready. Recent log: ${logPath}`);
  await run("tail", ["-n", "200", logPath]).catch(() => {});
  throw new Error(`Timed out waiting for ${label}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAdminBrowserE2e({
  name,
  database,
  postgresContainer,
  mqttContainer,
  mqttConfigDirectory,
  serviceLog,
  adminLog,
  testScript,
}) {
  printStep(name);
  let serviceApi;
  let adminUi;
  try {
    const postgres = await startPostgres(postgresContainer, database);
    const mqtt = await startMosquitto(mqttContainer, mqttConfigDirectory);
    const databaseUrl = `postgresql://vem:vem_password@${postgres.host}:${postgres.port}/${database}`;

    await run("pnpm", ["turbo", "build", "--filter", "service-api"]);
    await run("pnpm", ["--filter", "@vem/db", "migrate"], {
      env: {
        DATABASE_URL: databaseUrl,
      },
    });

    serviceApi = startProcess("node", ["dist/main.js"], {
      cwd: join(root, "apps/service-api"),
      logPath: serviceLog,
      env: {
        ...serviceApiEnv,
        DATABASE_URL: databaseUrl,
        MQTT_URL: `mqtt://${mqtt.host}:${mqtt.port}`,
      },
    });
    await waitForUrl(
      "http://localhost:3000/api/health",
      "Service API",
      serviceLog,
    );

    adminUi = startProcess("pnpm", ["dev", "--", "--strictPort"], {
      cwd: join(root, "apps/admin-ui"),
      logPath: adminLog,
    });
    await waitForUrl("http://localhost:5173", "Admin UI", adminLog);

    await run("google-chrome", ["--version"]);
    await run("pnpm", [testScript], { cwd: join(root, "apps/admin-ui") });
  } finally {
    await stopProcess(adminUi);
    await stopProcess(serviceApi);
    await dockerRm(mqttContainer);
    await dockerRm(postgresContainer);
  }
}

async function cleanup() {
  await Promise.all([...localProcesses].map((child) => stopProcess(child)));
  for (const container of [...localContainers]) {
    await dockerRm(container);
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function runStaticJob() {
  printStep("Static checks");
  await run("pnpm", ["fmt:check"]);
  await run("node", [
    "--test",
    "scripts/check-effective-config-hard-migration.test.mjs",
  ]);
  await run("pnpm", ["check:boundaries"]);
  await run("pnpm", ["check:script-inventory"]);
  await run("pnpm", ["check:static-quality-workflow"]);
  await run("pnpm", ["check:vision-main-consumer"]);
  await run("pnpm", ["check:vm-host-adapter"]);
  await run("pnpm", ["check:admin-api-contracts"]);
  await ensureCargoTypify();
  await run("pnpm", ["check:daemon-ipc-contracts"]);
  await run("pnpm", ["turbo", "typecheck"]);
  await run("pnpm", ["turbo", "lint"]);
}

async function runUnitJob() {
  printStep("Unit tests");
  await run("pnpm", [
    "turbo",
    "build",
    "--filter",
    "@vem/shared",
    "--filter",
    "@vem/db",
  ]);
  await run("pnpm", ["turbo", "test"]);
}

async function runAdminE2eJob() {
  await assertDockerPrerequisite();
  await assertChromePrerequisite();
  await runAdminBrowserE2e({
    name: "Admin UI browser E2E",
    database: "vem",
    postgresContainer: "vem-local-ci-postgres",
    mqttContainer: "vem-local-ci-mosquitto",
    mqttConfigDirectory: "/tmp/vem-local-ci-mosquitto",
    serviceLog: "service-api.log",
    adminLog: "admin-ui.log",
    testScript: "test:e2e",
  });
}

async function runRustJob() {
  printStep("Rust checks and tests");
  await run("cargo", [
    "check",
    "-p",
    "vending-core",
    "-p",
    "vending-daemon",
    "--all-targets",
  ]);
  await run("cargo", ["check", "-p", "machine", "--lib"]);
  await run("cargo", [
    "test",
    "-p",
    "vending-core",
    "-p",
    "vending-daemon",
    "--all-targets",
  ]);
}

function parseJobs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage: node tools/check-ci.mjs [--job <name> ...]",
        "",
        "Without --job, runs the non-Windows CI-equivalent check.",
        `Jobs: ${[...JOBS].join(", ")}`,
      ].join("\n"),
    );
    process.exit(0);
  }

  const selected = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--job") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const job = args[index + 1];
    if (!job || !JOBS.has(job)) {
      throw new Error(`Invalid --job value: ${job ?? "(missing)"}`);
    }
    selected.push(job);
    index += 1;
  }

  return selected.length > 0 ? selected : [...JOBS];
}

async function main() {
  const jobs = parseJobs();
  if (jobs.length === JOBS.size) {
    await assertLocalCiPrerequisites();
  }

  const runners = {
    "admin-e2e": runAdminE2eJob,
    rust: runRustJob,
    static: runStaticJob,
    unit: runUnitJob,
  };

  for (const job of jobs) {
    await runners[job]();
  }

  console.log("\nCI-equivalent check passed.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error.message);
    await cleanup();
    process.exit(1);
  });
