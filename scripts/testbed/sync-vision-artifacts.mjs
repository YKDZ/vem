import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadArtifactParallel } from "./download-github-artifact-parallel.mjs";

const DELIVERY_SCHEMA = "vending-vision-main-artifacts/v1";
const DELIVERY_FILE = "vending-vision-main-artifacts.json";

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function writeHostConfigVisionCore(configPath, identities) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.visionCoreArtifacts = {
    runtimeArchive: identities.runtimeArchive,
    recordedFixtureArchive: identities.recordedFixtureArchive,
  };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, configPath);
}

/**
 * 从 CI 外层归档同步同提交的 runtime/fixture 产物对：
 * 解包、校验交付清单、登记身份并原子更新宿主配置。
 */
export async function syncVisionArtifactsFromArchive({
  archivePath,
  commit,
  outputRoot,
  hostConfigPath,
}) {
  const staging = mkdtempSync(join(tmpdir(), "vem-vision-sync-"));
  execFileSync("unzip", ["-o", archivePath, "-d", staging], {
    stdio: "pipe",
  });
  const files = await readdir(staging);
  const deliveryName = files.find((name) => name === DELIVERY_FILE);
  if (!deliveryName) {
    throw new Error(`outer archive is missing ${DELIVERY_FILE}`);
  }
  const delivery = JSON.parse(
    await readFile(join(staging, deliveryName), "utf8"),
  );
  if (delivery.schemaVersion !== DELIVERY_SCHEMA) {
    throw new Error("delivery manifest schema is invalid");
  }
  if (delivery.commit !== commit) {
    throw new Error(
      `delivery manifest commit mismatch: expected ${commit}, got ${delivery.commit}`,
    );
  }
  const pairs = [
    ["runtimeArchive", delivery.runtime],
    ["recordedFixtureArchive", delivery.fixtures],
  ];
  const identities = {};
  for (const [key, declared] of pairs) {
    const source = join(staging, declared.file);
    const actualSha = await sha256File(source);
    if (actualSha !== declared.sha256) {
      throw new Error(`${key} SHA-256 does not match the delivery manifest`);
    }
    const byteSize = (await readFile(source)).length;
    const targetDir = join(outputRoot, key);
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, `${declared.sha256}.zip`);
    await copyFile(source, target);
    identities[key] = {
      hostPath: target,
      sha256: actualSha,
      byteSize,
      sourceCommit: commit,
    };
  }
  await writeHostConfigVisionCore(hostConfigPath, identities);
  return identities;
}

export function parseSyncOptions(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    flags.set(name, value);
    index += 1;
  }
  const commit = flags.get("commit");
  const outputRoot = flags.get("output-root");
  const hostConfigPath = flags.get("host-config");
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  if (!outputRoot || !hostConfigPath) {
    throw new Error("--output-root and --host-config are required");
  }
  return {
    commit,
    outputRoot: resolve(outputRoot),
    hostConfigPath: resolve(hostConfigPath),
    download: flags.has("download"),
    archive: flags.get("archive") ? resolve(flags.get("archive")) : null,
    repo: flags.get("repo") ?? "hbhjt/vending-vision",
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSyncOptions(args);
  let archivePath = options.archive;
  if (options.download) {
    const artifactName = `vending-vision-main-${options.commit}`;
    const downloaded = await downloadArtifactParallel({
      repo: options.repo,
      artifactName,
      output: join(tmpdir(), `vem-vision-main-${options.commit}.zip`),
      connections: 16,
      maxUrlRefreshes: 60,
      pollMs: 2_000,
    });
    archivePath = downloaded.path;
  }
  if (!archivePath) {
    throw new Error("--archive or --download is required");
  }
  const identities = await syncVisionArtifactsFromArchive({
    archivePath,
    commit: options.commit,
    outputRoot: options.outputRoot,
    hostConfigPath: options.hostConfigPath,
  });
  process.stdout.write(`${JSON.stringify(identities, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
