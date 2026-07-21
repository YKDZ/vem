#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  }).trim();
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

const args = process.argv.slice(2);
const envFile = resolve(
  option(args, "--env", process.env.BACKEND_ENV_FILE ?? ".env.backend-stack"),
);
const composeFile = resolve(
  option(args, "--compose", "apps/service-api/docker-compose.yml"),
);
const stateDirectory = resolve(
  option(args, "--state-dir", process.env.BACKEND_STATE_DIR ?? ".vem-backend"),
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

const record = {
  schemaVersion: "vem-backend-deployment/v1",
  deployedAt: new Date().toISOString(),
  configured,
  digests,
  composeFile,
  envFile,
  digestOverride: override,
};
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
run("docker", [...pinned, "ps"]);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
