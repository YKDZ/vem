#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return typeof output === "string" ? output.trim() : "";
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

export function validateCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(
      "--commit must be exactly a 40-character lowercase commit SHA",
    );
  }
  return value;
}

export function deploymentRecord({
  commit,
  configured,
  repoDigests,
  composeFile,
  envFile,
  digestOverride,
  deployedAt,
}) {
  return {
    schemaVersion: "vem-backend-deployment/v1",
    deployedAt,
    requestedCommit: validateCommit(commit),
    configured,
    repoDigests,
    composeFile,
    envFile,
    digestOverride,
  };
}

export function validateAdminProxyHealth(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Admin UI API proxy did not return JSON");
  }
  if (body?.data?.database !== "ok" || body?.data?.mqtt !== "connected") {
    throw new Error("Admin UI API proxy did not return healthy backend state");
  }
  return body;
}

export async function deploy(args = process.argv.slice(2), env = process.env) {
  const requestedCommit = validateCommit(option(args, "--commit"));
  const envFile = resolve(
    option(args, "--env", env.BACKEND_ENV_FILE ?? ".env.backend-stack"),
  );
  const composeFile = resolve(
    option(args, "--compose", "apps/service-api/docker-compose.yml"),
  );
  const stateDirectory = resolve(
    option(args, "--state-dir", env.BACKEND_STATE_DIR ?? ".vem-backend"),
  );
  mkdirSync(stateDirectory, { recursive: true });
  const override = resolve(stateDirectory, "digest-compose.yml");
  const recordPath = resolve(stateDirectory, "deployment.json");
  const compose = ["compose", "--env-file", envFile, "-f", composeFile];

  run("docker", [...compose, "pull"]);
  const configuredImages = run("docker", [...compose, "config", "--images"], {
    quiet: true,
  }).split("\n");
  const configured = {
    serviceApi: configuredImages.find((entry) => entry.includes("service-api")),
    adminUi: configuredImages.find((entry) => entry.includes("admin-ui")),
  };
  if (!configured.serviceApi || !configured.adminUi) {
    throw new Error("Compose must resolve Service API and Admin UI images");
  }
  for (const [service, image] of Object.entries(configured)) {
    if (!new RegExp(`:sha-${requestedCommit}$`).test(image)) {
      throw new Error(`${service} image must use sha-${requestedCommit}`);
    }
  }
  const repoDigest = (image) =>
    run("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", image], {
      quiet: true,
    });
  const digests = {
    serviceApi: repoDigest(configured.serviceApi),
    adminUi: repoDigest(configured.adminUi),
  };
  writeFileSync(
    override,
    `services:\n  service-api:\n    image: ${digests.serviceApi}\n  admin-ui:\n    image: ${digests.adminUi}\n`,
  );
  const pinned = [...compose, "-f", override];
  run("docker", [...pinned, "up", "-d", "--remove-orphans"]);

  for (const service of ["postgres", "mqtt", "service-api", "admin-ui"]) {
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const container = run("docker", [...pinned, "ps", "-q", service], {
        quiet: true,
      });
      if (
        container &&
        run(
          "docker",
          ["inspect", "--format", "{{.State.Health.Status}}", container],
          { quiet: true },
        ) === "healthy"
      ) {
        healthy = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
    if (!healthy) throw new Error(`${service} did not become healthy`);
  }

  const adminContainer = run("docker", [...pinned, "ps", "-q", "admin-ui"], {
    quiet: true,
  });
  const proxyHealth = run(
    "docker",
    ["exec", adminContainer, "wget", "-qO-", "http://127.0.0.1/api/health"],
    { quiet: true },
  );
  validateAdminProxyHealth(proxyHealth);

  const record = deploymentRecord({
    commit: requestedCommit,
    configured,
    repoDigests: digests,
    composeFile,
    envFile,
    digestOverride: override,
    deployedAt: new Date().toISOString(),
  });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  run("docker", [...pinned, "ps"]);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (import.meta.url === `file://${process.argv[1]}`) await deploy();
