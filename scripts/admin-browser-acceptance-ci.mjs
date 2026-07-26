#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const localContainers = new Set();
const localProcesses = new Set();

const serviceApiEnv = {
  JWT_SECRET: "ci-jwt-secret-at-least-32-characters-long!",
  JWT_REFRESH_SECRET: "ci-jwt-refresh-secret-minimum-32-chars!!",
  MACHINE_JWT_SECRET: "ci-machine-jwt-secret-min-32-chars-long!",
  MACHINE_CREDENTIAL_ENCRYPTION_KEY: "ci-machine-cred-enc-key-32-chars!!",
  MQTT_URL: "mqtt://localhost:1883",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_WEBHOOK_BASE_URL: "http://localhost:3000",
  BOOTSTRAP_ADMIN_PASSWORD: "AdminPassword123!",
  MEDIA_ASSET_STORAGE_ROOT: join(root, ".tmp", "admin-browser-media-assets"),
};

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

async function requireCommand(command, args = ["--version"]) {
  try {
    await capture(command, args);
  } catch {
    throw new Error(`Missing required command: ${command}.`);
  }
}

async function dockerRm(name) {
  try {
    await run("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // Best-effort cleanup for containers that may not exist.
  } finally {
    localContainers.delete(name);
  }
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

async function main() {
  console.log("\n==> Admin UI browser E2E");
  await requireCommand("docker");

  let serviceApi;
  let adminUi;
  try {
    const postgres = await startPostgres("vem-local-ci-postgres", "vem");
    const mqtt = await startMosquitto(
      "vem-local-ci-mosquitto",
      "/tmp/vem-local-ci-mosquitto",
    );
    const databaseUrl = `postgresql://vem:vem_password@${postgres.host}:${postgres.port}/vem`;

    await run("pnpm", [
      "turbo",
      "build",
      "--filter",
      "service-api",
      "--filter",
      "admin-ui",
      "--output-logs=errors-only",
      "--log-order=grouped",
      "--log-prefix=task",
    ]);
    await run("pnpm", ["exec", "playwright", "install", "chromium"], {
      cwd: join(root, "apps/admin-ui"),
    });
    await run("pnpm", ["--filter", "@vem/db", "migrate"], {
      env: { DATABASE_URL: databaseUrl },
    });

    serviceApi = startProcess("node", ["dist/main.js"], {
      cwd: join(root, "apps/service-api"),
      logPath: "service-api.log",
      env: {
        ...serviceApiEnv,
        DATABASE_URL: databaseUrl,
        MQTT_URL: `mqtt://${mqtt.host}:${mqtt.port}`,
      },
    });
    await waitForUrl(
      "http://localhost:3000/api/health",
      "Service API",
      "service-api.log",
    );

    adminUi = startProcess(
      "pnpm",
      [
        "exec",
        "vite",
        "preview",
        "--host",
        "0.0.0.0",
        "--port",
        "5173",
        "--strictPort",
      ],
      {
        cwd: join(root, "apps/admin-ui"),
        logPath: "admin-ui.log",
      },
    );
    await waitForUrl("http://localhost:5173", "Admin UI", "admin-ui.log");

    await run("pnpm", ["test:e2e"], {
      cwd: join(root, "apps/admin-ui"),
      env: { VEM_ADMIN_MUTATION_E2E_TARGET: "isolated" },
    });
  } finally {
    await stopProcess(adminUi);
    await stopProcess(serviceApi);
    await dockerRm("vem-local-ci-mosquitto");
    await dockerRm("vem-local-ci-postgres");
  }
}

main()
  .then(async () => {
    await cleanup();
  })
  .catch(async (error) => {
    console.error(error.message);
    await cleanup();
    process.exit(1);
  });
