#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runOwnedCommand } from "./lib/owned-process.mjs";
import {
  closeStagedFile,
  proveProductionRuntimeArtifactsForAi,
  revalidateStagedFile,
  stageRegularFile,
} from "./precutover-runtime-artifacts.mjs";

const RECEIPT_SCHEMA = "vem.precutover.ai.v1";
const VERIFIER_SCHEMA = "vem-trusted-vision-ai-precutover-verifier/v1";
const VERIFIER_IDENTITY =
  "sha256:2a9126536f89e9a8a0fc91a60246c5b9220de7b978ce64bc58853989d7883fd2";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const ISOLATED_RUNNER =
  "import runpy,sys;root,script=sys.argv[1:3];sys.path.insert(0,root);sys.argv=sys.argv[2:];runpy.run_path(script,run_name='__main__')";
const MATERIAL_NAMES = Object.freeze([
  "aiLock",
  "modelPackDescriptor",
  "runtimeDescriptor",
  "sourceDescriptor",
  "workerExecutable",
]);
const PATH_OPTIONS = new Set([
  "approved",
  "approval",
  "approval-attestation-bundle",
  "database-backup",
  "docker-binary",
  "gh-binary",
  "model-pack-archive",
  "output",
  "python",
  "release-set",
  "release-set-input-directory",
  "repo-root",
  "vem-runtime-archive",
  "vision-ai-verifier-root",
  "vision-candidate-input-directory",
  "vision-verifier-root",
]);

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function canonicalPrettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`${label} has missing or unknown fields`);
  }
}

function parseCanonical(raw, label, pretty = false) {
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) fail(`${label} is oversized`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is invalid JSON`);
  }
  const expected = pretty ? canonicalPrettyJson(value) : canonicalJson(value);
  if (raw !== expected) fail(`${label} is not canonical JSON`);
  return value;
}

function assertAbsolute(path, label) {
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
}

function heldIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function hashDescriptor(fileDescriptor, maximumBytes, label) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteSize = 0;
  for (;;) {
    const count = readSync(fileDescriptor, buffer, 0, buffer.length, byteSize);
    if (count === 0) break;
    byteSize += count;
    if (byteSize > maximumBytes) fail(`${label} exceeded its size cap`);
    digest.update(buffer.subarray(0, count));
  }
  return { byteSize, sha256: `sha256:${digest.digest("hex")}` };
}

function holdPrivateInstalledFile(path, expected, label) {
  const before = lstatSync(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    realpathSync(path) !== path ||
    before.size !== BigInt(expected.byteSize)
  ) {
    fail(`${label} is not the verified private file`);
  }
  const fileDescriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(fileDescriptor, { bigint: true });
    const facts = hashDescriptor(fileDescriptor, expected.byteSize, label);
    if (
      heldIdentity(opened) !== heldIdentity(before) ||
      facts.byteSize !== expected.byteSize ||
      facts.sha256 !== expected.sha256
    ) {
      fail(`${label} identity mismatch`);
    }
    return { expected, fileDescriptor, initialStat: opened, label, path };
  } catch (error) {
    closeSync(fileDescriptor);
    throw error;
  }
}

function revalidatePrivateInstalledFile(lease) {
  const held = fstatSync(lease.fileDescriptor, { bigint: true });
  const current = lstatSync(lease.path, { bigint: true });
  if (
    !held.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    realpathSync(lease.path) !== lease.path ||
    heldIdentity(held) !== heldIdentity(lease.initialStat) ||
    heldIdentity(current) !== heldIdentity(held)
  ) {
    fail(`${lease.label} identity changed during worker probes`);
  }
  const facts = hashDescriptor(
    lease.fileDescriptor,
    lease.expected.byteSize,
    lease.label,
  );
  if (
    facts.byteSize !== lease.expected.byteSize ||
    facts.sha256 !== lease.expected.sha256
  ) {
    fail(`${lease.label} content changed during worker probes`);
  }
}

function cleanEnvironment(privateRoot) {
  return {
    PATH: "",
    PYTHONHASHSEED: "0",
    PYTHONHOME: "",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
    TEMP: privateRoot,
    TMP: privateRoot,
    TMPDIR: privateRoot,
  };
}

function loadVerifierDescriptor(repoRoot) {
  const descriptorPath = join(
    repoRoot,
    "trusted-vision-ai-precutover-verifier.json",
  );
  const raw = readFileSync(descriptorPath, "utf8");
  const descriptor = parseCanonical(raw, "AI verifier descriptor", true);
  exact(
    descriptor,
    [
      "entrypoint",
      "identity",
      "python",
      "repository",
      "revision",
      "schemaVersion",
      "scripts",
    ],
    "AI verifier descriptor",
  );
  if (
    descriptor.schemaVersion !== VERIFIER_SCHEMA ||
    descriptor.identity !== VERIFIER_IDENTITY ||
    descriptor.repository !== "hbhjt/vending-vision" ||
    !COMMIT_RE.test(descriptor.revision) ||
    descriptor.entrypoint !== "scripts/precutover_ai_model_pack.py"
  ) {
    fail("AI verifier descriptor authority mismatch");
  }
  const unsigned = { ...descriptor };
  delete unsigned.identity;
  if (
    sha256(JSON.stringify(canonicalValue(unsigned))) !== descriptor.identity
  ) {
    fail("AI verifier descriptor identity mismatch");
  }
  exact(
    descriptor.python,
    ["byteSize", "path", "sha256", "version"],
    "AI verifier Python",
  );
  if (
    !Number.isSafeInteger(descriptor.python.byteSize) ||
    descriptor.python.byteSize <= 0 ||
    !isAbsolute(descriptor.python.path) ||
    !SHA256_RE.test(descriptor.python.sha256) ||
    !/^Python 3\.11\./.test(descriptor.python.version)
  ) {
    fail("AI verifier Python identity is invalid");
  }
  const expectedScripts = [
    "scripts/ai_model_pack_release.py",
    "scripts/precutover_ai_model_pack.py",
    "scripts/precutover_ai_worker_probe.py",
    "vision/ai_model_pack.py",
    "vision/process_supervisor.py",
  ];
  if (
    !Array.isArray(descriptor.scripts) ||
    JSON.stringify(descriptor.scripts.map(({ path }) => path)) !==
      JSON.stringify(expectedScripts)
  ) {
    fail("AI verifier script set mismatch");
  }
  for (const script of descriptor.scripts) {
    exact(
      script,
      ["byteSize", "gitBlob", "path", "sha256"],
      "AI verifier script",
    );
    if (
      !Number.isSafeInteger(script.byteSize) ||
      script.byteSize <= 0 ||
      !/^[a-f0-9]{40}$/.test(script.gitBlob) ||
      !SHA256_RE.test(script.sha256)
    ) {
      fail("AI verifier script identity is invalid");
    }
  }
  return { descriptor, raw };
}

function stageTrustedVerifier({ descriptor, held, privateRoot, verifierRoot }) {
  assertAbsolute(verifierRoot, "Vision AI verifier root");
  if (
    !lstatSync(verifierRoot).isDirectory() ||
    realpathSync(verifierRoot) !== verifierRoot
  ) {
    fail("Vision AI verifier root is unsafe");
  }
  const stagedRoot = join(privateRoot, "vision-ai-verifier");
  mkdirSync(stagedRoot, { mode: 0o700 });
  for (const script of descriptor.scripts) {
    const parent = dirname(join(stagedRoot, script.path));
    mkdirSync(parent, { mode: 0o700, recursive: true });
    const lease = stageRegularFile(
      join(verifierRoot, script.path),
      join(stagedRoot, script.path),
      `Vision AI verifier ${script.path}`,
      MAX_JSON_BYTES,
    );
    held.push(lease);
    if (
      lease.facts.byteSize !== script.byteSize ||
      lease.facts.sha256 !== `sha256:${script.sha256}` ||
      createHash("sha1")
        .update(`blob ${lease.facts.byteSize}\0`)
        .update(readFileSync(lease.path))
        .digest("hex") !== script.gitBlob
    ) {
      fail(`Vision AI verifier script mismatch: ${script.path}`);
    }
  }
  return stagedRoot;
}

async function stageTrustedPython({
  descriptor,
  held,
  privateRoot,
  pythonPath,
}) {
  assertAbsolute(pythonPath, "trusted Python");
  if (pythonPath !== descriptor.python.path) {
    fail("trusted Python path differs from descriptor");
  }
  const lease = stageRegularFile(
    pythonPath,
    join(privateRoot, "python3.11"),
    "trusted Python",
    32 * 1024 * 1024,
    0o700,
  );
  held.push(lease);
  if (
    lease.facts.byteSize !== descriptor.python.byteSize ||
    lease.facts.sha256 !== `sha256:${descriptor.python.sha256}`
  ) {
    fail("trusted Python identity mismatch");
  }
  const version = await runOwnedCommand(lease.path, ["-I", "--version"], {
    deadlineMs: 10_000,
    env: cleanEnvironment(privateRoot),
    maximumOutputBytes: 1024,
  });
  if (version !== descriptor.python.version)
    fail("trusted Python version mismatch");
  return lease.path;
}

async function runPython(binary, args, privateRoot, platform) {
  if (platform !== "win32") {
    return runOwnedCommand(binary, args, {
      deadlineMs: 120_000,
      env: cleanEnvironment(privateRoot),
      maximumOutputBytes: MAX_COMMAND_OUTPUT,
    });
  }
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: cleanEnvironment(privateRoot),
    maxBuffer: MAX_COMMAND_OUTPUT,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) fail(`trusted Python failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`trusted Python failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseSingleReport(raw, label) {
  if (typeof raw !== "string")
    fail(`${label} must emit exactly one JSON object`);
  return parseCanonical(raw.endsWith("\n") ? raw : `${raw}\n`, label);
}

function parseRuntimeDescriptor(path) {
  const descriptor = parseCanonical(
    readFileSync(path, "utf8"),
    "AI runtime descriptor",
  );
  exact(
    descriptor,
    [
      "directRequirements",
      "python",
      "requirementsAiLockSha256",
      "requirementsAiSha256",
      "schemaVersion",
      "target",
      "workerLayout",
    ],
    "AI runtime descriptor",
  );
  if (
    descriptor.schemaVersion !== "vem-ai-runtime-descriptor/v1" ||
    descriptor.target !== "windows-x86_64" ||
    !Array.isArray(descriptor.directRequirements)
  ) {
    fail("AI runtime descriptor identity is invalid");
  }
  return descriptor;
}

function directRequirementVersions(runtime) {
  const versions = {};
  for (const requirement of runtime.directRequirements) {
    const match = /^([a-z0-9-]+)==([^;\s]+)$/.exec(requirement);
    if (!match || Object.hasOwn(versions, match[1])) {
      fail("AI runtime direct requirement is not exact");
    }
    versions[match[1]] = match[2];
  }
  return versions;
}

function validateWorkerPayload(
  payload,
  expectedProbe,
  sourceRevision,
  runtime,
) {
  const versions = directRequirementVersions(runtime);
  exact(
    payload,
    ["catvtonSourceRevision", "probe", ...Object.keys(versions)],
    `${expectedProbe} payload`,
  );
  if (
    payload.probe !== expectedProbe ||
    payload.catvtonSourceRevision !== sourceRevision
  ) {
    fail("AI worker probe identity mismatch");
  }
  for (const [name, version] of Object.entries(versions)) {
    if (payload[name] !== version)
      fail(`AI worker dependency mismatch: ${name}`);
  }
  return payload;
}

function validateProbeEnvelope(raw, expectedProbe, sourceRevision, runtime) {
  const envelope = parseSingleReport(raw, "AI worker supervisor report");
  exact(
    envelope,
    ["returncode", "stderr", "stdout"],
    "AI worker supervisor report",
  );
  if (envelope.returncode !== 0 || envelope.stderr !== "") {
    fail("AI worker probe failed");
  }
  return validateWorkerPayload(
    parseSingleReport(envelope.stdout, "AI worker report"),
    expectedProbe,
    sourceRevision,
    runtime,
  );
}

function writeExclusive(path, contents, validateInputs) {
  const parent = dirname(path);
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) {
    fail("AI receipt parent is unsafe");
  }
  const staging = join(
    parent,
    `.${process.pid}-${randomBytes(8).toString("hex")}.ai.tmp`,
  );
  try {
    writeFileSync(staging, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    validateInputs();
    linkSync(staging, path);
    rmSync(staging);
  } finally {
    rmSync(staging, { force: true });
  }
}

async function verify(options, dependencies) {
  for (const [key, value] of Object.entries(options)) {
    if (PATH_OPTIONS.has(key)) assertAbsolute(value, `--${key}`);
  }
  const privateRoot = mkdtempSync(join(tmpdir(), "vem-precutover-ai-"));
  const held = [];
  const installedHeld = [];
  try {
    if ((lstatSync(privateRoot).mode & 0o077) !== 0)
      fail("AI private root is unsafe");
    const runtimeReceiptPath = join(privateRoot, "runtime-artifacts.json");
    const materialRoot = join(privateRoot, "runtime-materials");
    const runtimeProof = await dependencies.proveRuntimeArtifacts(
      { ...options, output: runtimeReceiptPath },
      materialRoot,
    );
    if (
      !runtimeProof?.releaseSet ||
      !runtimeProof?.receipt ||
      !runtimeProof?.aiMaterials
    ) {
      fail("fresh runtime artifact proof is incomplete");
    }
    const releaseSet = runtimeProof.releaseSet;
    const runtimeReceiptText = canonicalJson(runtimeProof.receipt);
    if (readFileSync(runtimeReceiptPath, "utf8") !== runtimeReceiptText) {
      fail("fresh runtime artifact receipt mismatch");
    }
    const stagedMaterials = {};
    const stagedMaterialRoot = join(privateRoot, "ai-materials");
    mkdirSync(stagedMaterialRoot, { mode: 0o700 });
    if (
      !Array.isArray(runtimeProof.aiMaterials.workerFiles) ||
      runtimeProof.aiMaterials.workerFiles.length === 0
    ) {
      fail("verified packaged AI worker onedir is missing");
    }
    const workerFiles = [];
    for (const file of runtimeProof.aiMaterials.workerFiles) {
      exact(
        file,
        ["byteSize", "path", "relative", "sha256"],
        "verified worker file",
      );
      if (
        typeof file.relative !== "string" ||
        file.relative === "" ||
        file.relative.startsWith("/") ||
        file.relative
          .split("/")
          .some((part) => part === "" || part === "." || part === "..") ||
        !DIGEST_RE.test(file.sha256)
      ) {
        fail("verified worker file identity is invalid");
      }
      const destination = join(stagedMaterialRoot, "worker", file.relative);
      mkdirSync(dirname(destination), { mode: 0o700, recursive: true });
      const lease = stageRegularFile(
        file.path,
        destination,
        `C2 packaged worker file ${file.relative}`,
        2 * 1024 * 1024 * 1024,
        file.path === runtimeProof.aiMaterials.workerExecutable.path
          ? 0o700
          : 0o600,
      );
      held.push(lease);
      if (
        lease.facts.sha256 !== file.sha256 ||
        lease.facts.byteSize !== file.byteSize
      ) {
        fail(
          `verified worker file changed after runtime proof: ${file.relative}`,
        );
      }
      workerFiles.push({ ...file, lease });
    }
    for (const name of MATERIAL_NAMES) {
      const material = runtimeProof.aiMaterials[name];
      if (!material || !isAbsolute(material.path))
        fail(`verified AI ${name} is missing`);
      const workerFile = workerFiles.find(
        ({ byteSize, path, sha256: digest }) =>
          path === material.path &&
          byteSize === material.byteSize &&
          digest === material.sha256,
      );
      if (workerFile === undefined) {
        fail(`verified AI ${name} is outside the packaged worker onedir`);
      }
      stagedMaterials[name] = workerFile.lease;
    }
    for (const [name, digest] of [
      ["runtimeDescriptor", releaseSet.ai.runtimeDescriptorSha256],
      ["aiLock", releaseSet.ai.requirementsLockSha256],
      ["modelPackDescriptor", releaseSet.ai.modelDescriptorSha256],
    ]) {
      if (stagedMaterials[name].facts.sha256 !== digest) {
        fail(`AI ${name} release identity mismatch`);
      }
    }
    const modelLease = stageRegularFile(
      options["model-pack-archive"],
      join(privateRoot, "official-model-pack.zip"),
      "official AI model-pack archive",
      MAX_MODEL_ARCHIVE_BYTES,
    );
    held.push(modelLease);
    if (
      modelLease.facts.byteSize !== releaseSet.ai.modelPackArchive.byteSize ||
      modelLease.facts.sha256 !== releaseSet.ai.modelPackArchive.sha256
    ) {
      fail("official AI model-pack archive release identity mismatch");
    }
    const verifier = loadVerifierDescriptor(options["repo-root"]);
    const stagedVerifierRoot = stageTrustedVerifier({
      descriptor: verifier.descriptor,
      held,
      privateRoot,
      verifierRoot: options["vision-ai-verifier-root"],
    });
    const trustedPython = await dependencies.stagePython({
      descriptor: verifier.descriptor,
      held,
      privateRoot,
      pythonPath: options.python,
    });
    const installRoot = join(privateRoot, "installed-model-pack");
    const modelReportRaw = await dependencies.runModelVerifier({
      archive: modelLease.path,
      descriptor: stagedMaterials.modelPackDescriptor.path,
      descriptorIdentity: stagedMaterials.modelPackDescriptor.facts,
      installRoot,
      modelIdentity: modelLease.facts,
      platform: dependencies.platform,
      privateRoot,
      python: trustedPython,
      verifierRoot: stagedVerifierRoot,
    });
    const modelReport = parseSingleReport(
      modelReportRaw,
      "official model-pack verifier report",
    );
    exact(
      modelReport,
      ["archive", "descriptor", "installedPack", "schemaVersion"],
      "official model-pack verifier report",
    );
    exact(
      modelReport.archive,
      ["byteSize", "sha256"],
      "official model-pack archive report",
    );
    exact(
      modelReport.descriptor,
      [
        "catvtonSourceRevision",
        "schemaVersion",
        "sha256",
        "totalByteSize",
        "upstreams",
      ],
      "official model-pack descriptor report",
    );
    const installedPack = join(
      installRoot,
      "packs",
      modelLease.facts.sha256.slice(7),
    );
    if (
      modelReport.schemaVersion !==
        "vending-vision-precutover-model-pack-proof/v1" ||
      modelReport.archive.byteSize !== modelLease.facts.byteSize ||
      `sha256:${modelReport.archive.sha256}` !== modelLease.facts.sha256 ||
      `sha256:${modelReport.descriptor.sha256}` !==
        stagedMaterials.modelPackDescriptor.facts.sha256 ||
      modelReport.descriptor.schemaVersion !==
        "vem-official-ai-model-pack-descriptor/v2" ||
      modelReport.installedPack !== installedPack
    ) {
      fail("official model-pack verifier facts mismatch");
    }
    if (
      !existsSync(installedPack) ||
      !lstatSync(installedPack).isDirectory() ||
      realpathSync(installedPack) !== installedPack
    ) {
      fail("official model-pack was not installed in the private root");
    }
    const modelDescriptor = parseCanonical(
      readFileSync(stagedMaterials.modelPackDescriptor.path, "utf8"),
      "official model-pack descriptor",
    );
    exact(
      modelDescriptor,
      [
        "catvtonSourceRevision",
        "files",
        "schemaVersion",
        "totalByteSize",
        "upstreams",
      ],
      "official model-pack descriptor",
    );
    if (
      !Array.isArray(modelDescriptor.files) ||
      modelDescriptor.files.length === 0
    ) {
      fail("official model-pack descriptor has no files");
    }
    for (const file of modelDescriptor.files) {
      exact(
        file,
        [
          "byteSize",
          "format",
          "path",
          "role",
          "sha256",
          "upstream",
          "upstreamPath",
        ],
        "official model-pack file",
      );
      if (
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize <= 0 ||
        !SHA256_RE.test(file.sha256) ||
        typeof file.path !== "string" ||
        file.path
          .split("/")
          .some((part) => part === "" || part === "." || part === "..")
      ) {
        fail("official model-pack file identity is invalid");
      }
      installedHeld.push(
        holdPrivateInstalledFile(
          join(installedPack, file.path),
          { byteSize: file.byteSize, sha256: `sha256:${file.sha256}` },
          `installed model file ${file.path}`,
        ),
      );
    }
    if (dependencies.platform !== "win32") {
      fail("packaged AI worker pre-cutover proof requires Windows");
    }
    const runtime = parseRuntimeDescriptor(
      stagedMaterials.runtimeDescriptor.path,
    );
    const source = parseCanonical(
      readFileSync(stagedMaterials.sourceDescriptor.path, "utf8"),
      "AI source descriptor",
    );
    if (!COMMIT_RE.test(source.catvtonSourceRevision))
      fail("AI source descriptor revision is invalid");
    exact(
      source,
      ["catvtonSourceRevision", "schemaVersion", "sources"],
      "AI source descriptor",
    );
    if (
      source.schemaVersion !== "vem-official-ai-source-descriptor/v1" ||
      !Array.isArray(source.sources)
    ) {
      fail("AI source descriptor identity is invalid");
    }
    if (
      modelReport.descriptor.catvtonSourceRevision !==
        source.catvtonSourceRevision ||
      modelReport.descriptor.totalByteSize !== modelDescriptor.totalByteSize ||
      canonicalJson(modelReport.descriptor.upstreams) !==
        canonicalJson(modelDescriptor.upstreams)
    ) {
      fail("model-pack and source revision mismatch");
    }
    const runtimeProbeRaw = await dependencies.runWorkerProbe({
      mode: "runtime",
      modelPack: undefined,
      platform: dependencies.platform,
      privateRoot,
      python: trustedPython,
      verifierRoot: stagedVerifierRoot,
      worker: stagedMaterials.workerExecutable.path,
    });
    const runtimeProbe = validateProbeEnvelope(
      runtimeProbeRaw,
      "official-catvton-worker-runtime",
      source.catvtonSourceRevision,
      runtime,
    );
    const modelProbeRaw = await dependencies.runWorkerProbe({
      mode: "model",
      modelPack: installedPack,
      platform: dependencies.platform,
      privateRoot,
      python: trustedPython,
      verifierRoot: stagedVerifierRoot,
      worker: stagedMaterials.workerExecutable.path,
    });
    const modelProbe = validateProbeEnvelope(
      modelProbeRaw,
      "official-catvton-worker",
      source.catvtonSourceRevision,
      runtime,
    );
    const receiptText = canonicalJson({
      identityRoot: {
        approvedPrecutoverSha256:
          runtimeProof.receipt.identityRoot.approvedPrecutoverSha256,
        releaseApprovalSha256:
          runtimeProof.receipt.identityRoot.releaseApprovalSha256,
        releaseSetSha256: runtimeProof.receipt.identityRoot.releaseSetSha256,
        runtimeArtifactsReceiptSha256: sha256(runtimeReceiptText),
      },
      modelPack: {
        archive: modelLease.facts,
        descriptor: {
          catvtonSourceRevision: source.catvtonSourceRevision,
          sha256: stagedMaterials.modelPackDescriptor.facts.sha256,
        },
      },
      probes: { model: modelProbe, runtime: runtimeProbe },
      runtime: {
        aiLockSha256: stagedMaterials.aiLock.facts.sha256,
        candidateSubjectSha256: runtimeProof.receipt.vision.archive.sha256,
        embeddedManifestSha256:
          runtimeProof.receipt.vision.embeddedManifestSha256,
        runtimeDescriptorSha256: stagedMaterials.runtimeDescriptor.facts.sha256,
        sourceCommit: runtimeProof.receipt.vision.sourceCommit,
        sourceDescriptorSha256: stagedMaterials.sourceDescriptor.facts.sha256,
        v2BundleSha256: runtimeProof.receipt.vision.v2BundleSha256,
        workerExecutableSha256: stagedMaterials.workerExecutable.facts.sha256,
      },
      schemaVersion: RECEIPT_SCHEMA,
      trustStatus: "pending_final_aggregate_approval",
      verifier: {
        descriptorIdentity: verifier.descriptor.identity,
        descriptorSha256: sha256(verifier.raw),
        revision: verifier.descriptor.revision,
      },
    });
    writeExclusive(options.output, receiptText, () => {
      for (const lease of held) revalidateStagedFile(lease);
      for (const lease of installedHeld) revalidatePrivateInstalledFile(lease);
      if (readFileSync(runtimeReceiptPath, "utf8") !== runtimeReceiptText) {
        fail("fresh runtime artifact receipt changed before publication");
      }
    });
    return receiptText;
  } finally {
    for (const lease of installedHeld.reverse())
      closeSync(lease.fileDescriptor);
    for (const lease of held.reverse()) closeStagedFile(lease);
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

async function productionModelVerifier(context) {
  const script = join(
    context.verifierRoot,
    "scripts/precutover_ai_model_pack.py",
  );
  return runPython(
    context.python,
    [
      "-I",
      "-c",
      ISOLATED_RUNNER,
      context.verifierRoot,
      script,
      "--archive",
      context.archive,
      "--descriptor",
      context.descriptor,
      "--expected-archive-byte-size",
      String(context.modelIdentity.byteSize),
      "--expected-archive-sha256",
      context.modelIdentity.sha256.slice(7),
      "--expected-descriptor-sha256",
      context.descriptorIdentity.sha256.slice(7),
      "--install-root",
      context.installRoot,
    ],
    context.privateRoot,
    context.platform,
  );
}

async function productionWorkerProbe(context) {
  const script = join(
    context.verifierRoot,
    "scripts/precutover_ai_worker_probe.py",
  );
  const args = [
    "-I",
    "-c",
    ISOLATED_RUNNER,
    context.verifierRoot,
    script,
    "--worker",
    context.worker,
    "--mode",
    context.mode,
    "--timeout",
    "60",
  ];
  if (context.modelPack !== undefined)
    args.push("--model-pack", context.modelPack);
  return runPython(context.python, args, context.privateRoot, context.platform);
}

export async function verifyPrecutoverAiForTest(options, dependencies) {
  if (process.env.NODE_ENV !== "test")
    fail("test-only AI proof boundary requires NODE_ENV=test");
  for (const name of [
    "proveRuntimeArtifacts",
    "runModelVerifier",
    "runWorkerProbe",
    "stagePython",
  ]) {
    if (typeof dependencies?.[name] !== "function")
      fail(`test dependency ${name} is required`);
  }
  return verify(options, dependencies);
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "verify") fail("usage: precutover-ai.mjs verify [options]");
  const required = [
    "approved",
    "approval",
    "approval-attestation-bundle",
    "approval-subject-sha256",
    "database-backup",
    "docker-binary",
    "expected-docker-byte-size",
    "expected-docker-sha256",
    "expected-docker-version",
    "gh-binary",
    "managed-media-origin",
    "managed-media-token",
    "model-pack-archive",
    "output",
    "python",
    "release-set",
    "release-set-input-directory",
    "repo-root",
    "postgres-container",
    "postgres-user",
    "source-commit",
    "source-ref",
    "vem-runtime-archive",
    "vision-ai-verifier-root",
    "vision-candidate-input-directory",
    "vision-source-ref",
    "vision-verifier-root",
  ];
  const options = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("invalid CLI arguments");
    const key = flag.slice(2);
    if (!required.includes(key) || Object.hasOwn(options, key))
      fail(`unknown or duplicate option: ${flag}`);
    options[key] = value;
  }
  for (const key of required)
    if (!Object.hasOwn(options, key)) fail(`missing --${key}`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await verify(options, {
    platform: process.platform,
    proveRuntimeArtifacts: proveProductionRuntimeArtifactsForAi,
    runModelVerifier: productionModelVerifier,
    runWorkerProbe: productionWorkerProbe,
    stagePython: stageTrustedPython,
  });
  process.stdout.write("PRECUTOVER_AI=PASS\n");
}

const invoked = process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`PRECUTOVER_AI=FAIL:${error.message}\n`);
    process.exitCode = 1;
  });
}
