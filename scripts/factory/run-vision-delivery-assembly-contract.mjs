#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CONTRACT_SCHEMA = "vem-delivery-assembly-execution-contract/v1";
const PROOF_SCHEMA = "vem-delivery-assembly-execution-proof/v1";
const NODE_PRODUCERS = new Set([
  "scripts/factory/build-factory-media.mjs",
  "scripts/factory/experimental-vision-candidate.mjs",
]);
const POWERSHELL_PRODUCERS = new Set([
  "scripts/windows/provision-vision-factory-release.ps1",
  "scripts/windows/prepare-factory-runtime.ps1",
]);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isSafeRepositoryPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function requireSuccessful(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} timed out`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
  return result;
}

function factoryProvisioningInput(contract) {
  const inputRoot = join(contract.root, "factory-input");
  const installers = join(inputRoot, "VISION-INSTALLER");
  mkdirSync(installers, { recursive: true });
  const files = {};
  for (const member of contract.members) {
    if (!isSafeRepositoryPath(member)) {
      throw new Error(`unsafe delivery member: ${String(member)}`);
    }
    const name = member.split("/").at(-1);
    const source = join(contract.repositoryRoot, member);
    const destination = join(installers, name);
    const bytes = readFileSync(source);
    copyFileSync(source, destination);
    files[`VISION-INSTALLER/${name}`] = digest(bytes);
  }
  writeFileSync(
    join(inputRoot, "VISION-FACTORY-PROVISIONING.JSON"),
    `${JSON.stringify({
      schemaVersion: "vem-vision-factory-provisioning/v1",
      kind: "vision-factory-provisioning",
      files: Object.fromEntries(
        Object.entries(files).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })}\n`,
  );
  return inputRoot;
}

function runProducer(contract, contractPath) {
  if (NODE_PRODUCERS.has(contract.producer)) {
    return requireSuccessful(
      process.execPath,
      [
        join(contract.repositoryRoot, contract.producer),
        "--delivery-assembly-contract",
        contractPath,
      ],
      { cwd: contract.repositoryRoot },
    );
  }
  if (!POWERSHELL_PRODUCERS.has(contract.producer)) {
    throw new Error(`unsupported delivery producer: ${contract.producer}`);
  }
  const producerPath = join(contract.repositoryRoot, contract.producer);
  const common = [
    "-NoProfile",
    "-File",
    producerPath,
    "-DeliveryAssemblyEvidenceOnly",
    "-DeliveryAssemblyOutputRoot",
    contract.outputRoot,
    "-DeliveryAssemblyContractNonce",
    contract.nonce,
  ];
  if (
    contract.producer === "scripts/windows/provision-vision-factory-release.ps1"
  ) {
    common.push("-FactoryMediaRoot", factoryProvisioningInput(contract));
  }
  return requireSuccessful("pwsh", common, { cwd: contract.repositoryRoot });
}

function main() {
  const index = process.argv.indexOf("--delivery-assembly-contract");
  const contractPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!contractPath) {
    throw new Error(
      "run-vision-delivery-assembly-contract.mjs --delivery-assembly-contract PATH",
    );
  }
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  if (
    contract?.schemaVersion !== CONTRACT_SCHEMA ||
    (!NODE_PRODUCERS.has(contract.producer) &&
      !POWERSHELL_PRODUCERS.has(contract.producer)) ||
    !isSafeRepositoryPath(contract.verifier) ||
    !Array.isArray(contract.members) ||
    contract.members.some((member) => !isSafeRepositoryPath(member)) ||
    typeof contract.artifact !== "string" ||
    typeof contract.outputRoot !== "string" ||
    typeof contract.root !== "string" ||
    typeof contract.nonce !== "string"
  ) {
    throw new Error("invalid delivery assembly execution contract");
  }
  try {
    statSync(contract.outputRoot);
    throw new Error(
      "checker output root must not exist before producer execution",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const producer = runProducer(contract, contractPath);
  if (!statSync(contract.outputRoot).isDirectory()) {
    throw new Error("producer did not create the checker output root");
  }
  let artifactPath = contract.artifact;
  if (contract.artifact.startsWith("stdout:")) {
    artifactPath = "producer-evidence.json";
    writeFileSync(join(contract.outputRoot, artifactPath), producer.stdout);
  }
  if (!isSafeRepositoryPath(artifactPath)) {
    throw new Error("unsafe staged delivery artifact path");
  }
  const verifier = requireSuccessful(
    process.execPath,
    [
      join(contract.repositoryRoot, contract.verifier),
      "--execution-contract",
      contractPath,
    ],
    { cwd: contract.repositoryRoot },
  );
  const verification = JSON.parse(verifier.stdout);
  const artifact = readFileSync(join(contract.outputRoot, artifactPath));
  writeFileSync(
    join(contract.root, "execution-proof.json"),
    `${JSON.stringify({
      schemaVersion: PROOF_SCHEMA,
      nonce: contract.nonce,
      root: contract.root,
      producer: contract.producer,
      verifier: contract.verifier,
      artifact: {
        name: contract.artifact,
        stagedPath: artifactPath,
        digest: digest(artifact),
      },
      verification,
    })}\n`,
    { mode: 0o600 },
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
