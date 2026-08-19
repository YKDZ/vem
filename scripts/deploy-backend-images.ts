#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface DeploymentRecord {
  schemaVersion: string;
  requestedCommit: string;
  deployedAt: string;
  repoDigests: { serviceApi: string; adminUi: string };
  environmentFile: string;
  composeFile: string;
}

function required(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  if (index < 0) throw new Error(`--${name} is required`);
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function remote(host: string, script: string): string {
  return run("ssh", [host, script], {});
}

export function deployBackendImages(args: string[]): DeploymentRecord {
  const host = required(args, "ssh");
  const commit = required(args, "commit");
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("--commit must be 40 hex");
  const envFile = required(args, "env-file");
  const composeFile = required(args, "compose-file");
  const recordPath = required(args, "record");
  const bundleIndex = args.indexOf("--bundle");
  const bundle: string | null = bundleIndex >= 0 ? args[bundleIndex + 1] : null;

  if (bundle) {
    run("scp", [bundle, `${host}:/tmp/vem-backend-images.tar.gz`]);
    remote(host, "docker load -i /tmp/vem-backend-images.tar.gz");
  } else {
    remote(
      host,
      `docker pull ghcr.io/ykdz/vem-service-api:sha-${commit} && docker pull ghcr.io/ykdz/vem-admin-ui:sha-${commit}`,
    );
  }

  remote(
    host,
    `sed -i "s#ghcr.io/ykdz/vem-service-api:[^ ]*#ghcr.io/ykdz/vem-service-api:sha-${commit}#g; s#ghcr.io/ykdz/vem-admin-ui:[^ ]*#ghcr.io/ykdz/vem-admin-ui:sha-${commit}#g" ${envFile}`,
  );
  remote(
    host,
    `docker compose --env-file ${envFile} -f ${composeFile} up -d --wait --wait-timeout 240`,
  );

  const serviceDigest = remote(
    host,
    `docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/ykdz/vem-service-api:sha-${commit}`,
  );
  const adminDigest = remote(
    host,
    `docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/ykdz/vem-admin-ui:sha-${commit}`,
  );
  const record: DeploymentRecord = {
    schemaVersion: "vem-backend-deployment/v1",
    requestedCommit: commit,
    deployedAt: new Date().toISOString(),
    repoDigests: { serviceApi: serviceDigest, adminUi: adminDigest },
    environmentFile: envFile,
    composeFile,
  };
  const recordJson = `${JSON.stringify(record, null, 2)}\n`;
  const localRecord = join(process.cwd(), "backend-deployment-record.json");
  writeFileSync(localRecord, recordJson);
  run("scp", [localRecord, `${host}:${recordPath}`]);
  return record;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(deployBackendImages(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
