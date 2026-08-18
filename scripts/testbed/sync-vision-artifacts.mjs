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
const CANDIDATE_SCHEMA = "vending-vision-candidate-artifact/v3";
const CANDIDATE_MANIFEST = "candidate-manifest.json";

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

export async function syncVisionArtifactPair({
  candidateArchivePath,
  mainArchivePath,
  commit,
  outputRoot,
  hostConfigPath,
}) {
  const staging = mkdtempSync(join(tmpdir(), "vem-vision-sync-"));
  execFileSync("unzip", ["-o", candidateArchivePath, "-d", join(staging, "candidate")], {
    stdio: "pipe",
  });
  execFileSync("unzip", ["-o", mainArchivePath, "-d", join(staging, "main")], {
    stdio: "pipe",
  });
  const candidateFiles = await readdir(join(staging, "candidate"));
  const candidateManifestName = candidateFiles.find(
    (name) => name === CANDIDATE_MANIFEST,
  );
  if (!candidateManifestName) {
    throw new Error(`candidate archive is missing ${CANDIDATE_MANIFEST}`);
  }
  const candidateManifest = JSON.parse(
    await readFile(join(staging, "candidate", candidateManifestName), "utf8"),
  );
  if (candidateManifest.schemaVersion !== CANDIDATE_SCHEMA) {
    throw new Error("candidate manifest schema is invalid");
  }
  if (candidateManifest.sourceCommit !== commit) {
    throw new Error(
      `candidate manifest commit mismatch: expected ${commit}, got ${candidateManifest.sourceCommit}`,
    );
  }
  const runtimeZipName = candidateFiles.find((name) =>
    name.startsWith("vending-vision-") && name.endsWith(".zip"),
  );
  if (!runtimeZipName) {
    throw new Error("candidate archive is missing the runtime zip");
  }

  const mainFiles = await readdir(join(staging, "main"));
  const deliveryName = mainFiles.find((name) => name === DELIVERY_FILE);
  if (!deliveryName) {
    throw new Error(`main archive is missing ${DELIVERY_FILE}`);
  }
  const delivery = JSON.parse(
    await readFile(join(staging, "main", deliveryName), "utf8"),
  );
  if (delivery.schemaVersion !== DELIVERY_SCHEMA) {
    throw new Error("delivery manifest schema is invalid");
  }
  if (delivery.commit !== commit) {
    throw new Error(
      `delivery manifest commit mismatch: expected ${commit}, got ${delivery.commit}`,
    );
  }
  const identities = {};
  const runtimeSource = join(staging, "candidate", runtimeZipName);
  const runtimeSha = await sha256File(runtimeSource);
  const runtimeTargetDir = join(outputRoot, "runtimeArchive");
  await mkdir(runtimeTargetDir, { recursive: true });
  const runtimeTarget = join(runtimeTargetDir, `${runtimeSha}.zip`);
  await copyFile(runtimeSource, runtimeTarget);
  identities.runtimeArchive = {
    hostPath: runtimeTarget,
    sha256: runtimeSha,
    byteSize: (await readFile(runtimeSource)).length,
    sourceCommit: commit,
  };

  const fixtureSource = join(staging, "main", delivery.fixtures.file);
  const fixtureSha = await sha256File(fixtureSource);
  if (fixtureSha !== delivery.fixtures.sha256) {
    throw new Error("fixture SHA-256 does not match the delivery manifest");
  }
  const fixtureTargetDir = join(outputRoot, "recordedFixtureArchive");
  await mkdir(fixtureTargetDir, { recursive: true });
  const fixtureTarget = join(fixtureTargetDir, `${fixtureSha}.zip`);
  await copyFile(fixtureSource, fixtureTarget);
  identities.recordedFixtureArchive = {
    hostPath: fixtureTarget,
    sha256: fixtureSha,
    byteSize: (await readFile(fixtureSource)).length,
    sourceCommit: commit,
  };
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
    candidateArchive: flags.get("candidate-archive")
      ? resolve(flags.get("candidate-archive"))
      : null,
    mainArchive: flags.get("main-archive")
      ? resolve(flags.get("main-archive"))
      : null,
    repo: flags.get("repo") ?? "hbhjt/vending-vision",
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSyncOptions(args);
  let candidateArchivePath = options.candidateArchive;
  let mainArchivePath = options.mainArchive;
  if (options.download) {
    const candidateDownload = await downloadArtifactParallel({
      repo: options.repo,
      artifactName: `vending-vision-candidate-${options.commit}`,
      output: join(tmpdir(), `vem-vision-candidate-${options.commit}.zip`),
      connections: 16,
      maxUrlRefreshes: 60,
      pollMs: 2_000,
    });
    candidateArchivePath = candidateDownload.path;
    const mainDownload = await downloadArtifactParallel({
      repo: options.repo,
      artifactName: `vending-vision-main-${options.commit}`,
      output: join(tmpdir(), `vem-vision-main-${options.commit}.zip`),
      connections: 16,
      maxUrlRefreshes: 60,
      pollMs: 2_000,
    });
    mainArchivePath = mainDownload.path;
  }
  if (!candidateArchivePath || !mainArchivePath) {
    throw new Error(
      "--candidate-archive and --main-archive or --download is required",
    );
  }
  const identities = await syncVisionArtifactPair({
    candidateArchivePath,
    mainArchivePath,
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
