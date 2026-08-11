#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runOwnedCommand } from "./lib/owned-process.mjs";
import {
  approvedPrecutoverStableProjectionText,
  proveProductionPrecutover,
  validateApprovedPrecutoverReceiptText,
  verifyTrustedVisionCandidateAttestation,
} from "./release-set-approval.mjs";
import {
  RUNTIME_DESCRIPTOR_FILE,
  readRuntimeArtifactDescriptor,
  validateRuntimeArtifactDescriptor,
  validateRuntimeArtifactDirectory,
} from "./windows/runtime-artifact-descriptor.mjs";

const RECEIPT_SCHEMA = "vem.precutover.runtime-artifacts.v1";
const VERIFIER_SCHEMA = "vem-trusted-vision-candidate-verifier/v1";
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_VEM_ARCHIVE_BYTES = 513 * 1024 * 1024;
const MAX_VISION_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const TRUSTED_RUNTIME_PROOF_AUTHORITY = Object.freeze({
  descriptorIdentity:
    "sha256:b8a1fede33ea6a9a8909dc6c39ce37148a6718ee1511d7fe4f4c3166f81798ef",
  descriptorSha256:
    "sha256:794971fcb5acaccb522ec028643806c8b132fa8f99b1d223aa91d6cd55f1f768",
  helper: Object.freeze({
    byteSize: 5264,
    gitBlob: "de96fe612de74d5754827fc03f2beff7002151b0",
    sha256:
      "sha256:ff92e47bbeb938ab20ea8409568f93df39823bd43be253b6de611040b1e47e3c",
  }),
  descriptorGitBlob: "014bce1157a1be1022240174117a2537258f7f42",
  git: Object.freeze({
    byteSize: 3_713_416,
    path: "/usr/bin/git",
    sha256:
      "sha256:2540879925a6881e3877ff7e3330746ba3027b04edf16a3a12dccd1644c4f32d",
    version: "git version 2.39.5",
  }),
  vemRevision: "971560e5191ad06b631f55a2bfaeb969e390d0e6",
  visionRevision: "072e3484f8db021950ce8b1773bd23c90e6e92c1",
});
const ISOLATED_VISION_RUNNER =
  "import runpy,sys;script=sys.argv[1];sys.path.insert(0,script.rsplit('/',1)[0]);sys.argv=sys.argv[1:];runpy.run_path(script,run_name='__main__')";
const CANDIDATE_FIXED_MEMBERS = new Set([
  "candidate-manifest.json",
  "github-build-provenance.sigstore.json",
  "trusted-builder-evidence.json",
]);
const PATH_OPTIONS = new Set([
  "approved",
  "approval",
  "approval-attestation-bundle",
  "database-backup",
  "docker-binary",
  "gh-binary",
  "output",
  "python",
  "release-set",
  "release-set-input-directory",
  "repo-root",
  "vem-runtime-archive",
  "vision-candidate-input-directory",
  "vision-verifier-root",
]);
const V2_FILES = [
  "__init__.py",
  "fixtures/client-invalid.json",
  "fixtures/client-valid.json",
  "fixtures/server-invalid.json",
  "fixtures/server-valid.json",
  "manifest.json",
  "python/__init__.py",
  "python/vision_v2_models.py",
  "vision-v2.client.schema.json",
  "vision-v2.server.schema.json",
];

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

function canonicalJsonValue(value) {
  return JSON.stringify(canonicalValue(value));
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

function parseCanonical(raw, label) {
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) fail(`${label} is oversized`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is invalid JSON`);
  }
  if (canonicalJson(value) !== raw) fail(`${label} is not canonical JSON`);
  return value;
}

function assertAbsolute(path, label) {
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
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

function hashHeldFile(fileDescriptor, maximumBytes, label) {
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

function validateHeldPath(path, fileDescriptor, initialStat, label) {
  const held = fstatSync(fileDescriptor, { bigint: true });
  const current = lstatSync(path, { bigint: true });
  if (
    !held.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    realpathSync(path) !== path ||
    heldIdentity(held) !== heldIdentity(initialStat) ||
    heldIdentity(current) !== heldIdentity(held)
  ) {
    fail(`${label} identity changed during verification`);
  }
}

function revalidateStagedFile(lease) {
  validateHeldPath(
    lease.source.path,
    lease.source.fileDescriptor,
    lease.source.initialStat,
    `${lease.label} source`,
  );
  validateHeldPath(
    lease.staging.path,
    lease.staging.fileDescriptor,
    lease.staging.initialStat,
    `${lease.label} private staging`,
  );
  const source = hashHeldFile(
    lease.source.fileDescriptor,
    lease.maximumBytes,
    `${lease.label} source`,
  );
  const staging = hashHeldFile(
    lease.staging.fileDescriptor,
    lease.maximumBytes,
    `${lease.label} private staging`,
  );
  if (
    canonicalJson(source) !== canonicalJson(lease.facts) ||
    canonicalJson(staging) !== canonicalJson(lease.facts)
  ) {
    fail(`${lease.label} content changed during verification`);
  }
}

function closeStagedFile(lease) {
  if (lease.closed) return;
  lease.closed = true;
  closeSync(lease.staging.fileDescriptor);
  closeSync(lease.source.fileDescriptor);
}

async function hashRegularFile(path, label, maximumBytes) {
  assertAbsolute(path, label);
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    realpathSync(path) !== path ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    fail(`${label} must be a bounded canonical regular file`);
  }
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  })) {
    byteSize += chunk.byteLength;
    if (byteSize > maximumBytes) fail(`${label} exceeded its size cap`);
    digest.update(chunk);
  }
  const after = lstatSync(path);
  if (identity(before) !== identity(after) || byteSize !== after.size) {
    fail(`${label} changed while hashing`);
  }
  return {
    byteSize,
    sha256: `sha256:${digest.digest("hex")}`,
  };
}

function stageRegularFile(
  source,
  destination,
  label,
  maximumBytes,
  mode = 0o600,
) {
  assertAbsolute(source, label);
  const before = lstatSync(source, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    realpathSync(source) !== source ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail(`${label} must be a bounded canonical regular file`);
  }
  let input;
  let output;
  let stagingInput;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(input, { bigint: true });
    if (heldIdentity(opened) !== heldIdentity(before))
      fail(`${label} changed before staging`);
    output = openSync(
      destination,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteSize = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (count === 0) break;
      byteSize += count;
      if (byteSize > maximumBytes) fail(`${label} exceeded its size cap`);
      let offset = 0;
      while (offset < count) {
        offset += writeSync(output, buffer, offset, count - offset);
      }
      digest.update(buffer.subarray(0, count));
    }
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    stagingInput = openSync(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const after = lstatSync(source, { bigint: true });
    const openedAfter = fstatSync(input, { bigint: true });
    const staged = fstatSync(stagingInput, { bigint: true });
    if (
      heldIdentity(before) !== heldIdentity(after) ||
      heldIdentity(before) !== heldIdentity(openedAfter) ||
      BigInt(byteSize) !== openedAfter.size ||
      BigInt(byteSize) !== staged.size
    ) {
      fail(`${label} changed while staging`);
    }
    return {
      closed: false,
      facts: { byteSize, sha256: `sha256:${digest.digest("hex")}` },
      label,
      maximumBytes,
      path: destination,
      source: { fileDescriptor: input, initialStat: openedAfter, path: source },
      staging: {
        fileDescriptor: stagingInput,
        initialStat: staged,
        path: destination,
      },
    };
  } catch (error) {
    if (stagingInput !== undefined) closeSync(stagingInput);
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
    rmSync(destination, { force: true });
    throw error;
  } finally {
    // Successful leases intentionally retain both descriptors until publication.
  }
}

function readRegularTextFile(path, label) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    realpathSync(path) !== path ||
    stat.size <= 0 ||
    stat.size > MAX_JSON_BYTES
  ) {
    fail(`${label} must be a bounded canonical regular file`);
  }
  return readFileSync(path, "utf8");
}

function readCanonicalFile(path, label) {
  const raw = readRegularTextFile(path, label);
  return { raw, value: parseCanonical(raw, label) };
}

function validateProvenIdentityRoot({
  approvedPath,
  expectedApprovalSha256,
  proven,
  releaseSetPath,
}) {
  const approved = readCanonicalFile(
    approvedPath,
    "approved precutover receipt",
  );
  validateApprovedPrecutoverReceiptText(approved.raw);
  validateApprovedPrecutoverReceiptText(proven.approvedText);
  const approvedProjection = approvedPrecutoverStableProjectionText(
    approved.raw,
  );
  const provenProjection = approvedPrecutoverStableProjectionText(
    proven.approvedText,
  );
  const releaseSet = readCanonicalFile(releaseSetPath, "release set");
  if (
    approvedProjection !== provenProjection ||
    !DIGEST_RE.test(expectedApprovalSha256) ||
    sha256(proven.approvalText) !== expectedApprovalSha256 ||
    expectedApprovalSha256 !== approved.value.releaseApprovalSha256 ||
    sha256(proven.manifestText) !== approved.value.releaseSetSha256 ||
    sha256(releaseSet.raw) !== approved.value.releaseSetSha256 ||
    proven.manifestText !== releaseSet.raw
  ) {
    fail("local approved receipt differs from the fresh production reproof");
  }
  if (
    proven.approval.sourceCommit !== approved.value.sourceCommit ||
    proven.approval.sourceRef !== approved.value.sourceRef ||
    proven.approval.inputArtifact.members["release-set.json"] !==
      approved.value.releaseSetSha256 ||
    proven.manifest.vem.sourceCommit !== approved.value.sourceCommit
  ) {
    fail("approved precutover release authority mismatch");
  }
  return {
    approvalSha256: sha256(proven.approvalText),
    approvedReceiptSha256: sha256(approved.raw),
    releaseSet: proven.manifest,
    releaseSetSha256: sha256(releaseSet.raw),
  };
}

function loadVerifierDescriptor(repoRoot) {
  const path = join(repoRoot, "trusted-vision-candidate-verifier.json");
  const raw = readRegularTextFile(path, "Vision verifier descriptor");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Vision verifier descriptor is invalid JSON");
  }
  if (canonicalPrettyJson(value) !== raw) {
    fail("Vision verifier descriptor is not formatter-canonical JSON");
  }
  if (
    sha256(raw) !== TRUSTED_RUNTIME_PROOF_AUTHORITY.descriptorSha256 ||
    value.identity !== TRUSTED_RUNTIME_PROOF_AUTHORITY.descriptorIdentity ||
    value.revision !== TRUSTED_RUNTIME_PROOF_AUTHORITY.visionRevision
  ) {
    fail(
      "Vision verifier descriptor is not authenticated by the VEM authority",
    );
  }
  exact(
    value,
    [
      "entrypoint",
      "identity",
      "python",
      "repository",
      "revision",
      "schemaVersion",
      "scripts",
    ],
    "Vision verifier descriptor",
  );
  if (
    value.schemaVersion !== VERIFIER_SCHEMA ||
    value.repository !== "hbhjt/vending-vision" ||
    !COMMIT_RE.test(value.revision) ||
    value.entrypoint !== "scripts/verify_trusted_candidate_inputs.py" ||
    !Array.isArray(value.scripts) ||
    value.scripts.length !== 2
  ) {
    fail("Vision verifier descriptor identity is invalid");
  }
  exact(
    value.python,
    ["byteSize", "path", "sha256", "version"],
    "Vision verifier Python",
  );
  if (
    !Number.isSafeInteger(value.python.byteSize) ||
    value.python.byteSize <= 0 ||
    !isAbsolute(value.python.path) ||
    !/^[a-f0-9]{64}$/.test(value.python.sha256) ||
    !/^Python 3\.11\.[0-9]+$/.test(value.python.version)
  ) {
    fail("Vision verifier Python descriptor is invalid");
  }
  const scriptPaths = value.scripts.map((script) => script.path);
  if (
    new Set(scriptPaths).size !== 2 ||
    JSON.stringify([...scriptPaths].sort()) !==
      JSON.stringify([
        "scripts/candidate_artifact_manifest.py",
        "scripts/verify_trusted_candidate_inputs.py",
      ])
  ) {
    fail("Vision verifier script set is invalid");
  }
  for (const script of value.scripts) {
    exact(script, ["byteSize", "path", "sha256"], "Vision verifier script");
    if (
      !Number.isSafeInteger(script.byteSize) ||
      script.byteSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(script.sha256)
    ) {
      fail("Vision verifier script descriptor is invalid");
    }
  }
  const identityInput = structuredClone(value);
  delete identityInput.identity;
  if (value.identity !== sha256(canonicalJsonValue(identityInput))) {
    fail("Vision verifier descriptor self identity mismatch");
  }
  return { raw, value };
}

async function materializePython({
  descriptor,
  heldInputs,
  pythonPath,
  staging,
}) {
  if (pythonPath !== descriptor.python.path) {
    fail("Vision verifier Python path differs from its descriptor");
  }
  const python = stageRegularFile(
    pythonPath,
    join(staging, "python3.11"),
    "Vision verifier Python",
    128 * 1024 * 1024,
    0o700,
  );
  heldInputs.push(python);
  if (
    python.facts.byteSize !== descriptor.python.byteSize ||
    python.facts.sha256 !== `sha256:${descriptor.python.sha256}`
  ) {
    fail("Vision verifier Python identity mismatch");
  }
  const version = await runOwnedCommand(python.path, ["-I", "--version"], {
    deadlineMs: 10_000,
    env: cleanPythonEnvironment(staging),
    maximumOutputBytes: 1024,
  });
  if (version !== descriptor.python.version) {
    fail("Vision verifier Python version mismatch");
  }
  return python.path;
}

function cleanPythonEnvironment(privateRoot) {
  return {
    HOME: privateRoot,
    LANG: "C.UTF-8",
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    TMPDIR: privateRoot,
  };
}

function cleanGitEnvironment(privateRoot) {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: privateRoot,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: privateRoot,
  };
}

async function verifyTrustedRepositoryAuthority(repoRoot, privateRoot) {
  assertAbsolute(repoRoot, "VEM repository root");
  if (
    !lstatSync(repoRoot).isDirectory() ||
    realpathSync(repoRoot) !== repoRoot
  ) {
    fail("VEM repository root is unsafe");
  }
  const gitAuthority = TRUSTED_RUNTIME_PROOF_AUTHORITY.git;
  const git = await hashRegularFile(
    gitAuthority.path,
    "trusted Git binary",
    16 * 1024 * 1024,
  );
  if (
    git.byteSize !== gitAuthority.byteSize ||
    git.sha256 !== gitAuthority.sha256
  ) {
    fail("trusted Git binary identity mismatch");
  }
  const environment = cleanGitEnvironment(privateRoot);
  const runGit = (args, maximumOutputBytes = 64 * 1024) =>
    runOwnedCommand(gitAuthority.path, args, {
      deadlineMs: 15_000,
      env: environment,
      maximumOutputBytes,
    });
  if ((await runGit(["--version"])) !== gitAuthority.version) {
    fail("trusted Git binary version mismatch");
  }
  const prefix = ["--no-optional-locks", "-C", repoRoot];
  if (
    (await runGit([...prefix, "rev-parse", "--show-toplevel"])) !== repoRoot
  ) {
    fail("VEM repository root does not identify the trusted worktree");
  }
  const head = await runGit([...prefix, "rev-parse", "HEAD"]);
  if (!COMMIT_RE.test(head)) fail("VEM repository HEAD is invalid");
  await runGit([
    ...prefix,
    "merge-base",
    "--is-ancestor",
    TRUSTED_RUNTIME_PROOF_AUTHORITY.vemRevision,
    head,
  ]);
  const expectedBlobs = {
    "scripts/lib/verify_vem_runtime_archive.py":
      TRUSTED_RUNTIME_PROOF_AUTHORITY.helper.gitBlob,
    "trusted-vision-candidate-verifier.json":
      TRUSTED_RUNTIME_PROOF_AUTHORITY.descriptorGitBlob,
  };
  for (const [path, expectedBlob] of Object.entries(expectedBlobs)) {
    if (
      (await runGit([...prefix, "rev-parse", `HEAD:${path}`])) !== expectedBlob
    ) {
      fail(`VEM repository HEAD blob is not trusted: ${path}`);
    }
  }
  const status = await runGit([
    ...prefix,
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
    "--",
    ...Object.keys(expectedBlobs),
  ]);
  if (status !== "") fail("VEM trusted verifier files differ from HEAD");
  return head;
}

async function materializeVisionVerifier({
  descriptor,
  heldInputs,
  verifierRoot,
  staging,
}) {
  assertAbsolute(verifierRoot, "Vision verifier root");
  if (
    !lstatSync(verifierRoot).isDirectory() ||
    realpathSync(verifierRoot) !== verifierRoot
  ) {
    fail("Vision verifier root is unsafe");
  }
  mkdirSync(staging, { mode: 0o700 });
  for (const script of descriptor.scripts) {
    exact(script, ["byteSize", "path", "sha256"], "Vision verifier script");
    if (!/^scripts\/[a-z0-9_]+\.py$/.test(script.path)) {
      fail("Vision verifier script path is invalid");
    }
    const source = join(verifierRoot, script.path);
    const destination = join(staging, basename(script.path));
    const staged = stageRegularFile(
      source,
      destination,
      script.path,
      1024 * 1024,
    );
    heldInputs.push(staged);
    const facts = staged.facts;
    if (
      facts.byteSize !== script.byteSize ||
      facts.sha256 !== `sha256:${script.sha256}`
    ) {
      fail(`Vision verifier script identity mismatch: ${script.path}`);
    }
    const copied = await hashRegularFile(destination, script.path, 1024 * 1024);
    if (canonicalJson(copied) !== canonicalJson(facts)) {
      fail(`Vision verifier staged bytes changed: ${script.path}`);
    }
  }
  return join(staging, basename(descriptor.entrypoint));
}

function exactVisionCandidateInputs(directory) {
  assertAbsolute(directory, "Vision candidate input directory");
  if (
    !lstatSync(directory).isDirectory() ||
    realpathSync(directory) !== directory
  ) {
    fail("Vision candidate input directory is unsafe");
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    entries.length !== 4 ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail("Vision candidate input must contain exactly four regular files");
  }
  const names = entries.map((entry) => entry.name);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    fail("Vision candidate input has a case collision");
  }
  const archiveNames = names.filter((name) => name.endsWith(".zip"));
  if (
    archiveNames.length !== 1 ||
    ![...CANDIDATE_FIXED_MEMBERS].every((name) => names.includes(name))
  ) {
    fail("Vision candidate input member set is invalid");
  }
  return {
    archive: join(directory, archiveNames[0]),
    attestation: join(directory, "github-build-provenance.sigstore.json"),
    evidence: join(directory, "trusted-builder-evidence.json"),
    manifest: join(directory, "candidate-manifest.json"),
  };
}

function stageVisionCandidateInputs(directory, heldInputs, staging) {
  const before = lstatSync(directory);
  const inputs = exactVisionCandidateInputs(directory);
  mkdirSync(staging, { mode: 0o700 });
  const result = {};
  for (const [name, source] of Object.entries(inputs)) {
    const maximum =
      name === "archive" ? MAX_VISION_ARCHIVE_BYTES : MAX_JSON_BYTES;
    const staged = stageRegularFile(
      source,
      join(staging, basename(source)),
      `Vision candidate ${name}`,
      maximum,
    );
    heldInputs.push(staged);
    result[name] = staged;
  }
  exactVisionCandidateInputs(directory);
  if (identity(before) !== identity(lstatSync(directory))) {
    fail("Vision candidate input directory changed while staging");
  }
  return result;
}

async function verifyVemArchive({
  archivePath,
  beforeHelperExecute,
  heldInputs,
  identityRoot,
  pythonPath,
  repoRoot,
  tempRoot,
}) {
  const staged = stageRegularFile(
    archivePath,
    join(tempRoot, "vem-runtime.zip"),
    "VEM runtime archive",
    MAX_VEM_ARCHIVE_BYTES,
  );
  heldInputs.push(staged);
  const archive = staged.facts;
  if (archive.sha256 !== identityRoot.releaseSet.windowsRuntime.archiveSha256) {
    fail("VEM runtime archive digest mismatch");
  }
  const destination = join(tempRoot, "vem-runtime");
  const helperPath = join(
    repoRoot,
    "scripts/lib/verify_vem_runtime_archive.py",
  );
  const helper = stageRegularFile(
    helperPath,
    join(tempRoot, "verify_vem_runtime_archive.py"),
    "VEM runtime archive verifier",
    1024 * 1024,
  );
  heldInputs.push(helper);
  if (
    helper.facts.byteSize !== TRUSTED_RUNTIME_PROOF_AUTHORITY.helper.byteSize ||
    helper.facts.sha256 !== TRUSTED_RUNTIME_PROOF_AUTHORITY.helper.sha256
  ) {
    fail(
      "VEM runtime archive verifier is not authenticated by the VEM authority",
    );
  }
  await beforeHelperExecute?.({
    sourcePath: helperPath,
    stagedPath: helper.path,
  });
  const reportText = await runOwnedCommand(
    pythonPath,
    [
      "-I",
      helper.path,
      "verify",
      "--archive",
      staged.path,
      "--destination",
      destination,
    ],
    {
      deadlineMs: 300_000,
      env: cleanPythonEnvironment(tempRoot),
      maximumOutputBytes: 1024 * 1024,
    },
  );
  const report = JSON.parse(reportText);
  if (
    `sha256:${report.archiveSha256}` !== archive.sha256 ||
    report.archiveByteSize !== archive.byteSize
  ) {
    fail("VEM runtime extractor report mismatch");
  }
  const descriptorPath = join(destination, RUNTIME_DESCRIPTOR_FILE);
  const descriptorFacts = await hashRegularFile(
    descriptorPath,
    "VEM runtime descriptor",
    MAX_JSON_BYTES,
  );
  if (
    descriptorFacts.sha256 !==
    identityRoot.releaseSet.windowsRuntime.descriptorSha256
  ) {
    fail("VEM runtime descriptor digest mismatch");
  }
  const descriptor = await readRuntimeArtifactDescriptor(destination);
  validateRuntimeArtifactDescriptor(descriptor, {
    commit: identityRoot.releaseSet.windowsRuntime.sourceCommit,
  });
  await validateRuntimeArtifactDirectory(destination, descriptor);
  return {
    archive,
    descriptor: {
      identity: descriptor.identity,
      sha256: descriptorFacts.sha256,
      sourceCommit: descriptor.commit,
    },
    files: descriptor.artifacts.map(({ bytes, digest, name, role }) => ({
      byteSize: bytes,
      name,
      role,
      sha256: digest,
    })),
  };
}

function verifyExtractedV2Bundle(extractedRoot, repoRoot, expectedDigest) {
  const packagedRoot = join(
    extractedRoot,
    "vending-vision/_internal/contracts/vem_vision_v2",
  );
  const repositoryRoot = join(repoRoot, "packages/shared/generated/vision-v2");
  const actual = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
      else if (entry.isFile()) actual.push(relative);
      else fail("Vision V2 bundle contains a non-regular member");
    }
  };
  visit(packagedRoot);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...V2_FILES].sort())) {
    fail("Vision candidate V2 bundle member set mismatch");
  }
  for (const relative of V2_FILES) {
    if (
      !readFileSync(join(packagedRoot, relative)).equals(
        readFileSync(join(repositoryRoot, relative)),
      )
    ) {
      fail(`Vision candidate V2 bundle bytes mismatch: ${relative}`);
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(packagedRoot, "manifest.json"), "utf8"),
  );
  if (`sha256:${manifest.bundleDigest}` !== expectedDigest) {
    fail("Vision candidate V2 bundle digest mismatch");
  }
  return expectedDigest;
}

async function verifyVisionArchive({
  candidateDirectory,
  descriptor,
  ghBinaryPath,
  heldInputs,
  identityRoot,
  pythonPath,
  repoRoot,
  tempRoot,
  verifierRoot,
  verifyVisionAttestation,
  visionSourceRef,
}) {
  const stagedInputs = stageVisionCandidateInputs(
    candidateDirectory,
    heldInputs,
    join(tempRoot, "vision-inputs"),
  );
  const subject = stagedInputs.archive.facts;
  const manifest = stagedInputs.manifest.facts;
  const attestation = stagedInputs.attestation.facts;
  const evidence = stagedInputs.evidence.facts;
  const expected = identityRoot.releaseSet.vision;
  for (const [actual, wanted, label] of [
    [subject.sha256, expected.candidateSubjectSha256, "subject"],
    [manifest.sha256, expected.embeddedManifestSha256, "embedded manifest"],
    [
      attestation.sha256,
      expected.attestationBundleSha256,
      "attestation bundle",
    ],
    [evidence.sha256, expected.supplierEvidenceSha256, "supplier evidence"],
  ]) {
    if (actual !== wanted) fail(`Vision candidate ${label} digest mismatch`);
  }
  await verifyVisionAttestation({
    artifactPath: stagedInputs.archive.path,
    attestationBundlePath: stagedInputs.attestation.path,
    ghBinaryPath,
    sourceCommit: expected.sourceCommit,
    sourceRef: visionSourceRef,
    subjectSha256: subject.sha256.slice(7),
  });
  const verifierPath = await materializeVisionVerifier({
    descriptor,
    heldInputs,
    verifierRoot,
    staging: join(tempRoot, "vision-verifier"),
  });
  const extracted = join(tempRoot, "vision-candidate");
  await runOwnedCommand(
    pythonPath,
    [
      "-I",
      "-c",
      ISOLATED_VISION_RUNNER,
      verifierPath,
      "--artifact",
      stagedInputs.archive.path,
      "--candidate-manifest",
      stagedInputs.manifest.path,
      "--github-attestation",
      stagedInputs.attestation.path,
      "--trusted-builder-evidence",
      stagedInputs.evidence.path,
      "--destination",
      extracted,
      "--subject-sha256",
      subject.sha256.slice(7),
      "--manifest-sha256",
      manifest.sha256.slice(7),
      "--attestation-bundle-sha256",
      attestation.sha256.slice(7),
      "--source-commit",
      expected.sourceCommit,
    ],
    {
      deadlineMs: 600_000,
      env: cleanPythonEnvironment(tempRoot),
      maximumOutputBytes: 8 * 1024 * 1024,
    },
  );
  const candidateManifestRaw = readFileSync(stagedInputs.manifest.path, "utf8");
  let candidateManifest;
  try {
    candidateManifest = JSON.parse(candidateManifestRaw);
  } catch {
    fail("Vision candidate manifest is invalid JSON");
  }
  if (canonicalJsonValue(candidateManifest) !== candidateManifestRaw) {
    fail("Vision candidate manifest is not canonical JSON");
  }
  const bindings = candidateManifest.bindings;
  const required = {
    aiLock: identityRoot.releaseSet.ai.requirementsLockSha256,
    modelPackDescriptor: identityRoot.releaseSet.ai.modelDescriptorSha256,
    runtimeDescriptor: identityRoot.releaseSet.ai.runtimeDescriptorSha256,
  };
  for (const [name, expectedDigest] of Object.entries(required)) {
    if (`sha256:${bindings?.[name]?.sha256}` !== expectedDigest) {
      fail(`Vision candidate ${name} binding mismatch`);
    }
  }
  const v2BundleSha256 = verifyExtractedV2Bundle(
    extracted,
    repoRoot,
    identityRoot.releaseSet.visionV2Bundle.bundleSha256,
  );
  return {
    archive: subject,
    attestationBundleSha256: attestation.sha256,
    bindings: Object.fromEntries(
      Object.entries(bindings).map(([name, value]) => [
        name,
        { path: value.path, sha256: `sha256:${value.sha256}` },
      ]),
    ),
    embeddedManifestSha256: manifest.sha256,
    sourceCommit: expected.sourceCommit,
    supplierEvidenceSha256: evidence.sha256,
    v2BundleSha256,
  };
}

function validateReceipt(receipt) {
  exact(
    receipt,
    [
      "identityRoot",
      "schemaVersion",
      "trustStatus",
      "vem",
      "verifier",
      "vision",
    ],
    "runtime artifacts receipt",
  );
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA ||
    receipt.trustStatus !== "pending_final_aggregate_approval" ||
    !DIGEST_RE.test(receipt.verifier.descriptorIdentity)
  ) {
    fail("runtime artifacts receipt identity is invalid");
  }
  exact(
    receipt.identityRoot,
    ["approvedPrecutoverSha256", "releaseApprovalSha256", "releaseSetSha256"],
    "runtime artifacts identity root",
  );
  if (
    Object.values(receipt.identityRoot).some((value) => !DIGEST_RE.test(value))
  ) {
    fail("runtime artifacts identity root digest is invalid");
  }
  exact(receipt.vem, ["archive", "descriptor", "files"], "VEM runtime facts");
  exact(
    receipt.vem.archive,
    ["byteSize", "sha256"],
    "VEM runtime archive facts",
  );
  exact(
    receipt.vem.descriptor,
    ["identity", "sha256", "sourceCommit"],
    "VEM runtime descriptor facts",
  );
  if (
    !Number.isSafeInteger(receipt.vem.archive.byteSize) ||
    receipt.vem.archive.byteSize <= 0 ||
    !DIGEST_RE.test(receipt.vem.archive.sha256) ||
    !DIGEST_RE.test(receipt.vem.descriptor.identity) ||
    !DIGEST_RE.test(receipt.vem.descriptor.sha256) ||
    !COMMIT_RE.test(receipt.vem.descriptor.sourceCommit) ||
    !Array.isArray(receipt.vem.files) ||
    receipt.vem.files.length !== 3
  ) {
    fail("VEM runtime receipt facts are invalid");
  }
  for (const file of receipt.vem.files) {
    exact(
      file,
      ["byteSize", "name", "role", "sha256"],
      "VEM runtime file facts",
    );
    if (
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize <= 0 ||
      !DIGEST_RE.test(file.sha256) ||
      typeof file.name !== "string" ||
      typeof file.role !== "string"
    ) {
      fail("VEM runtime file facts are invalid");
    }
  }
  exact(
    receipt.verifier,
    [
      "descriptorIdentity",
      "descriptorSha256",
      "revision",
      "vemAuthorityRevision",
      "vemRepositoryHead",
    ],
    "Vision verifier facts",
  );
  if (
    !DIGEST_RE.test(receipt.verifier.descriptorSha256) ||
    !COMMIT_RE.test(receipt.verifier.revision) ||
    receipt.verifier.vemAuthorityRevision !==
      TRUSTED_RUNTIME_PROOF_AUTHORITY.vemRevision ||
    !COMMIT_RE.test(receipt.verifier.vemRepositoryHead)
  ) {
    fail("Vision verifier receipt facts are invalid");
  }
  exact(
    receipt.vision,
    [
      "archive",
      "attestationBundleSha256",
      "bindings",
      "embeddedManifestSha256",
      "sourceCommit",
      "supplierEvidenceSha256",
      "v2BundleSha256",
    ],
    "Vision candidate facts",
  );
  exact(receipt.vision.archive, ["byteSize", "sha256"], "Vision archive facts");
  exact(
    receipt.vision.bindings,
    [
      "aiLock",
      "mainExecutable",
      "modelPackDescriptor",
      "runtimeDescriptor",
      "sourceDescriptor",
      "workerExecutable",
    ],
    "Vision candidate bindings",
  );
  for (const binding of Object.values(receipt.vision.bindings)) {
    exact(binding, ["path", "sha256"], "Vision candidate binding");
    if (typeof binding.path !== "string" || !DIGEST_RE.test(binding.sha256)) {
      fail("Vision candidate binding facts are invalid");
    }
  }
  if (
    !Number.isSafeInteger(receipt.vision.archive.byteSize) ||
    receipt.vision.archive.byteSize <= 0 ||
    !DIGEST_RE.test(receipt.vision.archive.sha256) ||
    !DIGEST_RE.test(receipt.vision.attestationBundleSha256) ||
    !DIGEST_RE.test(receipt.vision.embeddedManifestSha256) ||
    !DIGEST_RE.test(receipt.vision.supplierEvidenceSha256) ||
    !DIGEST_RE.test(receipt.vision.v2BundleSha256) ||
    !COMMIT_RE.test(receipt.vision.sourceCommit)
  ) {
    fail("Vision candidate receipt facts are invalid");
  }
  return receipt;
}

function writeExclusive(path, contents, validateInputs) {
  const parent = dirname(path);
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) {
    fail("runtime artifacts receipt parent is unsafe");
  }
  const staging = join(
    parent,
    `.${process.pid}-${randomBytes(8).toString("hex")}.runtime-artifacts.tmp`,
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

async function verify(
  options,
  { beforeVemHelperExecute, provePrecutover, verifyVisionAttestation },
) {
  for (const [key, value] of Object.entries(options)) {
    if (PATH_OPTIONS.has(key)) assertAbsolute(value, `--${key}`);
  }
  const proven = await provePrecutover(options);
  const identityRoot = validateProvenIdentityRoot({
    approvedPath: options.approved,
    expectedApprovalSha256: options["approval-subject-sha256"],
    proven,
    releaseSetPath: options["release-set"],
  });
  const tempRoot = mkdtempSync(join(tmpdir(), "vem-runtime-artifacts-"));
  const heldInputs = [];
  try {
    const directoryStat = lstatSync(tempRoot);
    if ((directoryStat.mode & 0o077) !== 0)
      fail("private verification root is unsafe");
    const vemRepositoryHead = await verifyTrustedRepositoryAuthority(
      options["repo-root"],
      tempRoot,
    );
    const verifier = loadVerifierDescriptor(options["repo-root"]);
    const trustedPython = await materializePython({
      descriptor: verifier.value,
      heldInputs,
      pythonPath: options.python,
      staging: tempRoot,
    });
    const vem = await verifyVemArchive({
      archivePath: options["vem-runtime-archive"],
      beforeHelperExecute: beforeVemHelperExecute,
      heldInputs,
      identityRoot,
      pythonPath: trustedPython,
      repoRoot: options["repo-root"],
      tempRoot,
    });
    const vision = await verifyVisionArchive({
      candidateDirectory: options["vision-candidate-input-directory"],
      descriptor: verifier.value,
      ghBinaryPath: options["gh-binary"],
      heldInputs,
      identityRoot,
      pythonPath: trustedPython,
      repoRoot: options["repo-root"],
      tempRoot,
      verifierRoot: options["vision-verifier-root"],
      verifyVisionAttestation,
      visionSourceRef: options["vision-source-ref"],
    });
    const receiptText = canonicalJson(
      validateReceipt({
        identityRoot: {
          approvedPrecutoverSha256: identityRoot.approvedReceiptSha256,
          releaseApprovalSha256: identityRoot.approvalSha256,
          releaseSetSha256: identityRoot.releaseSetSha256,
        },
        schemaVersion: RECEIPT_SCHEMA,
        trustStatus: "pending_final_aggregate_approval",
        vem,
        verifier: {
          descriptorIdentity: verifier.value.identity,
          descriptorSha256: sha256(verifier.raw),
          revision: verifier.value.revision,
          vemAuthorityRevision: TRUSTED_RUNTIME_PROOF_AUTHORITY.vemRevision,
          vemRepositoryHead,
        },
        vision,
      }),
    );
    writeExclusive(options.output, receiptText, () => {
      for (const lease of heldInputs) revalidateStagedFile(lease);
    });
  } finally {
    for (const lease of heldInputs.reverse()) closeStagedFile(lease);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function proveRuntimePrecutover(options) {
  return proveProductionPrecutover({
    approvalPath: options.approval,
    attestationBundlePath: options["approval-attestation-bundle"],
    backupPath: options["database-backup"],
    container: options["postgres-container"],
    dockerBinary: options["docker-binary"],
    expectedDockerByteSize: options["expected-docker-byte-size"],
    expectedDockerSha256: options["expected-docker-sha256"],
    expectedDockerVersion: options["expected-docker-version"],
    ghBinaryPath: options["gh-binary"],
    inputDirectory: options["release-set-input-directory"],
    managedMediaOrigin: options["managed-media-origin"],
    managedMediaToken: options["managed-media-token"],
    repoRoot: options["repo-root"],
    sourceCommit: options["source-commit"],
    sourceRef: options["source-ref"],
    sourceUser: options["postgres-user"],
  });
}

export async function verifyRuntimeArtifactsForTest(
  options,
  provePrecutover,
  verifyVisionAttestation = async () => {},
  beforeVemHelperExecute,
) {
  if (process.env.NODE_ENV !== "test") {
    fail("test-only runtime artifact verifier requires NODE_ENV=test");
  }
  if (typeof provePrecutover !== "function") {
    fail("test-only precutover proof boundary must be callable");
  }
  return verify(options, {
    beforeVemHelperExecute,
    provePrecutover,
    verifyVisionAttestation,
  });
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "verify")
    fail("usage: precutover-runtime-artifacts.mjs verify [options]");
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
    if (!required.includes(key) || key in options)
      fail(`unknown or duplicate option: ${flag}`);
    options[key] = value;
  }
  for (const key of required) if (!options[key]) fail(`--${key} is required`);
  return options;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    await verify(parseArgs(process.argv.slice(2)), {
      provePrecutover: proveRuntimePrecutover,
      verifyVisionAttestation: verifyTrustedVisionCandidateAttestation,
    });
    process.stdout.write("PRECUTOVER_RUNTIME_ARTIFACTS=PASS\n");
  } catch (error) {
    process.stderr.write(
      `PRECUTOVER_RUNTIME_ARTIFACTS=FAIL:${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
