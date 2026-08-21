import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { downloadArtifactParallel } from "./download-github-artifact-parallel.ts";

const DELIVERY_SCHEMA = "vending-vision-main-artifacts/v1";
const DELIVERY_FILE = "vending-vision-main-artifacts.json";
const RUNTIME_FILE = "vending-vision-windows-x86_64.zip";
const FIXTURE_FILE = "vending-vision-test-fixtures.zip";

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function parseDeliveryManifest(content, commit) {
  let delivery;
  try {
    delivery = JSON.parse(content);
  } catch {
    throw new Error("delivery manifest is invalid JSON");
  }
  if (delivery?.schemaVersion !== DELIVERY_SCHEMA) {
    throw new Error("delivery manifest schema is invalid");
  }
  if (delivery.commit !== commit) {
    throw new Error(
      `delivery manifest commit mismatch: expected ${commit}, got ${delivery.commit}`,
    );
  }
  return delivery;
}

async function verifiedMember(root, delivery, kind, expectedFile) {
  const member = delivery[kind];
  if (
    !member ||
    member.file !== expectedFile ||
    basename(member.file) !== member.file ||
    !/^[a-f0-9]{64}$/.test(member.sha256) ||
    !Number.isSafeInteger(member.bytes) ||
    member.bytes < 0
  ) {
    throw new Error(`${kind} delivery manifest member is invalid`);
  }
  const path = join(root, member.file);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${kind} delivery manifest member is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${kind} delivery manifest member is not a regular file`);
  }
  if (metadata.size !== member.bytes) {
    throw new Error(`${kind} delivery manifest bytes do not match`);
  }
  const sha256 = await sha256File(path);
  if (sha256 !== member.sha256) {
    throw new Error(`${kind} delivery manifest SHA-256 does not match`);
  }
  return { path, sha256, byteSize: metadata.size };
}

async function resolveVisionArtifactPair(mainArtifactRoot, commit) {
  const root = resolve(mainArtifactRoot);
  const manifestPath = join(root, DELIVERY_FILE);
  let manifestMetadata;
  try {
    manifestMetadata = await lstat(manifestPath);
  } catch {
    throw new Error(`main artifact root is missing ${DELIVERY_FILE}`);
  }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error("delivery manifest is not a regular file");
  }
  const delivery = parseDeliveryManifest(
    await readFile(manifestPath, "utf8"),
    commit,
  );
  return {
    runtime: await verifiedMember(root, delivery, "runtime", RUNTIME_FILE),
    fixtures: await verifiedMember(root, delivery, "fixtures", FIXTURE_FILE),
  };
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

export async function syncVisionArtifactPair({
  mainArtifactRoot,
  commit,
  outputRoot,
  hostConfigPath,
}) {
  const pair = await resolveVisionArtifactPair(mainArtifactRoot, commit);
  const identities = {};
  for (const [source, identityName, cacheDirectory] of [
    [pair.runtime, "runtimeArchive", "runtimeArchive"],
    [pair.fixtures, "recordedFixtureArchive", "recordedFixtureArchive"],
  ]) {
    const targetDir = join(outputRoot, cacheDirectory);
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, `${source.sha256}.zip`);
    await copyFile(source.path, target);
    identities[identityName] = {
      hostPath: target,
      sha256: source.sha256,
      byteSize: source.byteSize,
      sourceCommit: commit,
    };
  }
  await writeHostConfigVisionCore(hostConfigPath, identities);
  return identities;
}

export function parseSyncOptions(args) {
  const flags = new Map();
  const valueFlags = new Set([
    "commit",
    "output-root",
    "host-config",
    "main-artifact-root",
    "repo",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (name === "download") {
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.has(name)) {
      throw new Error(`unknown option: --${name}`);
    }
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
  const mainArtifactRoot = flags.get("main-artifact-root");
  if (!flags.has("download") && !mainArtifactRoot) {
    throw new Error("--main-artifact-root or --download is required");
  }
  if (flags.has("download") && mainArtifactRoot) {
    throw new Error(
      "--main-artifact-root and --download are mutually exclusive",
    );
  }
  return {
    commit,
    outputRoot: resolve(outputRoot),
    hostConfigPath: resolve(hostConfigPath),
    mainArtifactRoot: mainArtifactRoot ? resolve(mainArtifactRoot) : null,
    download: flags.has("download"),
    repo: flags.get("repo") ?? "hbhjt/vending-vision",
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSyncOptions(args);
  let mainArtifactRoot = options.mainArtifactRoot;
  if (options.download) {
    const archive = await downloadArtifactParallel({
      repo: options.repo,
      artifactName: `vending-vision-main-${options.commit}`,
      output: join(tmpdir(), `vem-vision-main-${options.commit}.zip`),
      connections: 16,
      maxUrlRefreshes: 60,
      pollMs: 2_000,
    });
    const staging = mkdtempSync(join(tmpdir(), "vem-vision-main-"));
    execFileSync("unzip", ["-o", archive.path, "-d", staging], {
      stdio: "pipe",
    });
    mainArtifactRoot = staging;
  }
  const identities = await syncVisionArtifactPair({
    mainArtifactRoot,
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
