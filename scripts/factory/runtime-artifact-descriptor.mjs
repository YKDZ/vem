import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "./factory-manifest.mjs";

export const RUNTIME_ARTIFACT_FILES = Object.freeze([
  { role: "vem-daemon", name: "vending-daemon.exe" },
  { role: "vem-machine-ui", name: "machine.exe" },
  { role: "webview2-loader", name: "WebView2Loader.dll" },
]);
export const RUNTIME_DESCRIPTOR_FILE = "WINDOWS-RUNTIME-ARTIFACTS.json";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TOOLCHAIN_KEYS = [
  "runnerImage",
  "runnerImageVersion",
  "node",
  "pnpm",
  "rustc",
  "cargo",
  "tauriCli",
];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

async function hashRegularFile(path, label) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${label} must be a regular file`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    return { digest: `sha256:${hash.digest("hex")}`, bytes };
  } finally {
    await handle.close();
  }
}

function descriptorIdentity(descriptor) {
  const core = structuredClone(descriptor);
  delete core.identity;
  return `sha256:${createHash("sha256").update(canonicalJson(core)).digest("hex")}`;
}

export async function createRuntimeArtifactDescriptor({
  runtimeDirectory,
  commit,
  artifactName,
  workflowRunIdentity,
  toolchain,
}) {
  if (!COMMIT.test(commit ?? ""))
    throw new Error("commit must be a full Git SHA");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifactName ?? "")) {
    throw new Error("artifactName must be a bounded safe artifact identity");
  }
  if (
    !/^github-actions:\/\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+\/attempts\/[0-9]+$/.test(
      workflowRunIdentity ?? "",
    )
  ) {
    throw new Error("workflowRunIdentity is invalid");
  }
  validateToolchain(toolchain);
  const artifacts = [];
  for (const definition of RUNTIME_ARTIFACT_FILES) {
    const hashed = await hashRegularFile(
      join(runtimeDirectory, definition.name),
      definition.name,
    );
    artifacts.push({ ...definition, ...hashed });
  }
  const descriptor = {
    schemaVersion: "vem-runtime-artifact-descriptor/v1",
    kind: "vem-runtime-artifact-descriptor",
    commit,
    workflow: { identity: workflowRunIdentity, artifactName },
    toolchain: structuredClone(toolchain),
    artifacts,
  };
  return { ...descriptor, identity: descriptorIdentity(descriptor) };
}

function validateToolchain(toolchain) {
  exactKeys(toolchain, TOOLCHAIN_KEYS, "toolchain");
  for (const key of ["runnerImage", "runnerImageVersion"]) {
    if (typeof toolchain[key] !== "string" || toolchain[key].length === 0) {
      throw new Error(`toolchain.${key} must be a non-empty string`);
    }
  }
  for (const key of ["node", "pnpm", "rustc", "cargo", "tauriCli"]) {
    if (!VERSION.test(toolchain[key] ?? "")) {
      throw new Error(`toolchain.${key} must be a strict semantic version`);
    }
  }
}

export function validateRuntimeArtifactDescriptor(descriptor, expected = {}) {
  exactKeys(
    descriptor,
    [
      "schemaVersion",
      "kind",
      "identity",
      "commit",
      "workflow",
      "toolchain",
      "artifacts",
    ],
    "runtime descriptor",
  );
  if (descriptor.schemaVersion !== "vem-runtime-artifact-descriptor/v1") {
    throw new Error("runtime descriptor schemaVersion is invalid");
  }
  if (descriptor.kind !== "vem-runtime-artifact-descriptor") {
    throw new Error("runtime descriptor kind is invalid");
  }
  if (!COMMIT.test(descriptor.commit ?? "")) {
    throw new Error("runtime descriptor commit is invalid");
  }
  exactKeys(
    descriptor.workflow,
    ["identity", "artifactName"],
    "runtime descriptor workflow",
  );
  validateToolchain(descriptor.toolchain);
  if (
    !Array.isArray(descriptor.artifacts) ||
    descriptor.artifacts.length !== RUNTIME_ARTIFACT_FILES.length
  ) {
    throw new Error("runtime descriptor must contain exactly three artifacts");
  }
  descriptor.artifacts.forEach((artifact, index) => {
    exactKeys(
      artifact,
      ["role", "name", "digest", "bytes"],
      `runtime descriptor artifacts[${index}]`,
    );
    const expectedFile = RUNTIME_ARTIFACT_FILES[index];
    if (
      artifact.role !== expectedFile.role ||
      artifact.name !== expectedFile.name
    ) {
      throw new Error(
        `runtime descriptor artifacts[${index}] role/name is invalid`,
      );
    }
    if (
      !DIGEST.test(artifact.digest ?? "") ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > MAX_ARTIFACT_BYTES
    ) {
      throw new Error(
        `runtime descriptor artifacts[${index}] digest/bytes is invalid`,
      );
    }
  });
  if (
    descriptor.artifacts.reduce(
      (total, artifact) => total + artifact.bytes,
      0,
    ) > MAX_TOTAL_ARTIFACT_BYTES
  ) {
    throw new Error("runtime descriptor artifacts exceed the total size limit");
  }
  if (descriptor.identity !== descriptorIdentity(descriptor)) {
    throw new Error("runtime descriptor identity does not match its content");
  }
  const bindings = [
    ["artifactIdentity", descriptor.identity],
    ["artifactName", descriptor.workflow.artifactName],
    ["commit", descriptor.commit],
    ["workflowRunIdentity", descriptor.workflow.identity],
  ];
  for (const [key, actual] of bindings) {
    if (expected[key] !== undefined && expected[key] !== actual) {
      throw new Error(
        `runtime descriptor ${key} does not match workflow output`,
      );
    }
  }
  return structuredClone(descriptor);
}

export async function writeRuntimeArtifactDescriptor(
  runtimeDirectory,
  descriptor,
) {
  validateRuntimeArtifactDescriptor(descriptor);
  await writeFile(
    join(runtimeDirectory, RUNTIME_DESCRIPTOR_FILE),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    { mode: 0o444 },
  );
}

export async function validateRuntimeArtifactDirectory(
  runtimeDirectory,
  descriptor,
) {
  const allowed = new Set([
    RUNTIME_DESCRIPTOR_FILE,
    ...RUNTIME_ARTIFACT_FILES.map(({ name }) => name),
  ]);
  const entries = await readdir(runtimeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new Error(
        `unexpected runtime upload file outside allowlist: ${entry.name}`,
      );
    }
    if (!entry.isFile()) {
      throw new Error(
        `runtime upload entry must be a regular file: ${entry.name}`,
      );
    }
  }
  if (entries.length !== allowed.size) {
    throw new Error(
      "runtime upload directory does not contain the exact allowlist",
    );
  }
  for (const artifact of descriptor.artifacts) {
    const actual = await hashRegularFile(
      join(runtimeDirectory, artifact.name),
      artifact.name,
    );
    if (actual.digest !== artifact.digest || actual.bytes !== artifact.bytes) {
      throw new Error(
        `runtime artifact digest or bytes mismatch: ${artifact.name}`,
      );
    }
  }
}

export async function readRuntimeArtifactDescriptor(runtimeDirectory) {
  const path = join(runtimeDirectory, RUNTIME_DESCRIPTOR_FILE);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${RUNTIME_DESCRIPTOR_FILE} must not be a symlink`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      fileStat.size < 2 ||
      fileStat.size > 1024 * 1024
    ) {
      throw new Error(
        `${RUNTIME_DESCRIPTOR_FILE} must be a bounded regular file`,
      );
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) {
      throw new Error(`${RUNTIME_DESCRIPTOR_FILE} read was incomplete`);
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument: ${argv[index] ?? ""}`);
    }
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const descriptor = await createRuntimeArtifactDescriptor({
    runtimeDirectory: options.directory,
    commit: options.commit,
    artifactName: options["artifact-name"],
    workflowRunIdentity: options["workflow-run-identity"],
    toolchain: JSON.parse(options["toolchain-json"]),
  });
  await writeRuntimeArtifactDescriptor(options.directory, descriptor);
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
