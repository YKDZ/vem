#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalAiAcceptanceInputManifest,
  validateAiAcceptanceInputManifest,
} from "./ai-acceptance-input-provisioning.mjs";

const SOURCE_COMMIT = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`AI acceptance input manifest creation ${message}`);
}

function absolute(path, label) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail(`${label} must be absolute`);
  return resolve(path);
}

async function describeFile(path, label, sourceCommit) {
  const hostPath = absolute(path, label);
  const entry = await lstat(hostPath).catch(() => fail(`${label} is missing`));
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be a regular file`);
  const bytes = await readFile(hostPath);
  return {
    hostPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

async function describeDirectory(path, label, nested) {
  const hostPath = absolute(path, label);
  const root = await lstat(hostPath).catch(() => fail(`${label} is missing`));
  if (!root.isDirectory() || root.isSymbolicLink())
    fail(`${label} must be a regular directory`);
  const members = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const memberPath = `${directory}${sep}${entry.name}`;
      const name = relative(hostPath, memberPath).split(sep).join("/");
      if (entry.isSymbolicLink()) fail(`${label} must not contain symlinks`);
      if (entry.isDirectory()) {
        if (!nested) fail(`${label} must contain regular files only`);
        await visit(memberPath);
        continue;
      }
      if (!entry.isFile()) fail(`${label} must contain regular files only`);
      const bytes = await readFile(memberPath);
      members.push({
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      });
    }
  }
  await visit(hostPath);
  members.sort((left, right) => left.name.localeCompare(right.name));
  if (members.length === 0) fail(`${label} must not be empty`);
  return {
    hostPath,
    sha256: createHash("sha256")
      .update(
        members
          .map(
            (member) =>
              `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
          )
          .join(""),
      )
      .digest("hex"),
    byteSize: members.reduce((sum, member) => sum + member.byteSize, 0),
    members,
  };
}

function authoritySourceCommit(raw) {
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("acceptance authority receipt is not JSON");
  }
  const commits = [
    receipt?.candidate?.sourceCommit,
    receipt?.visionCore?.runtimeArchive?.sourceCommit,
    receipt?.visionCore?.recordedFixtureArchive?.sourceCommit,
  ];
  if (
    commits.some((commit) => !SOURCE_COMMIT.test(commit ?? "")) ||
    new Set(commits).size !== 1
  ) {
    fail("acceptance authority Vision source commit is invalid");
  }
  return commits[0];
}

export async function buildMeasurementAiAcceptanceInputManifest(options) {
  const receiptPath = absolute(
    options.acceptanceAuthorityReceipt,
    "acceptance authority receipt",
  );
  const sourceCommit = authoritySourceCommit(
    await readFile(receiptPath, "utf8"),
  );
  return {
    acceptanceAuthorityReceipt: await describeFile(
      receiptPath,
      "acceptance authority receipt",
    ),
    candidateInput: await describeDirectory(
      options.candidateInputDirectory,
      "candidate input directory",
      false,
    ),
    installedVisionRuntimeArchive: await describeFile(
      options.installedVisionRuntimeArchive,
      "installed Vision runtime archive",
      sourceCommit,
    ),
    modelPack: {
      archive: await describeFile(
        options.modelPackArchive,
        "model pack archive",
      ),
      delivery: { kind: "host-local-cache" },
      materializedRoot: await describeDirectory(
        options.materializedModelPackRoot,
        "materialized model pack root",
        true,
      ),
    },
    phase: "measurement",
    recordedFixtureArchive: await describeFile(
      options.recordedFixtureArchive,
      "recorded fixture archive",
      sourceCommit,
    ),
    schemaVersion: "vem-runtime-testbed-ai-input/v4",
    windowsProofInput: await describeDirectory(
      options.windowsProofInputDirectory,
      "Windows proof input directory",
      false,
    ),
  };
}

export async function createMeasurementAiAcceptanceInputManifest(options) {
  const outputPath = absolute(options.outputPath, "output");
  const value = await buildMeasurementAiAcceptanceInputManifest(options);
  const raw = canonicalAiAcceptanceInputManifest(value);
  await validateAiAcceptanceInputManifest(raw);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, raw, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return {
    outputPath,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "create-measurement") {
    fail(
      "usage: ai-acceptance-input-manifest.mjs create-measurement [options]",
    );
  }
  const required = [
    "acceptance-authority-receipt",
    "candidate-input-directory",
    "installed-vision-runtime-archive",
    "materialized-model-pack-root",
    "model-pack-archive",
    "output",
    "recorded-fixture-archive",
    "windows-proof-input-directory",
  ];
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("arguments are invalid");
    const key = flag.slice(2);
    if (!required.includes(key) || Object.hasOwn(values, key))
      fail(`unknown or duplicate --${key}`);
    values[key] = value;
  }
  for (const key of required) if (!values[key]) fail(`--${key} is required`);
  return {
    acceptanceAuthorityReceipt: values["acceptance-authority-receipt"],
    candidateInputDirectory: values["candidate-input-directory"],
    installedVisionRuntimeArchive: values["installed-vision-runtime-archive"],
    materializedModelPackRoot: values["materialized-model-pack-root"],
    modelPackArchive: values["model-pack-archive"],
    outputPath: values.output,
    recordedFixtureArchive: values["recorded-fixture-archive"],
    windowsProofInputDirectory: values["windows-proof-input-directory"],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  createMeasurementAiAcceptanceInputManifest(parseArgs(process.argv.slice(2)))
    .then((result) =>
      process.stdout.write(
        `AI_ACCEPTANCE_INPUT_MANIFEST=PASS:${result.sha256}\n`,
      ),
    )
    .catch((error) => {
      process.stderr.write(
        `AI_ACCEPTANCE_INPUT_MANIFEST=FAIL:${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
