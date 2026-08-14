import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";

const SCHEMA_VERSION = "vem-runtime-testbed-ai-input/v4";
const AUTHORITY_SCHEMA = "vem.testbed.ai-acceptance-authority/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const GUEST_ROOT = "C:\\ProgramData\\VEM\\testbed\\ai-inputs";
const CANDIDATE_MEMBERS = new Set([
  "candidate-manifest.json",
  "github-build-provenance.sigstore.json",
  "trusted-builder-evidence.json",
]);
const WINDOWS_PROOF_MEMBERS = new Set([
  "precutover-ai-proof.json",
  "precutover-ai-proof.sigstore.json",
  "trusted-precutover-proof-evidence.json",
]);
const CALIBRATION_FIELDS = [
  "calibratedRegionalPolicy",
  "calibrationReceipt",
  "calibrationSourceInput",
];
const CALIBRATION_DOCUMENTS = [
  ["acceptanceReport", "acceptance-report.json"],
  ["acceptanceAuthorityReceipt", "acceptance-authority-receipt.json"],
  ["releaseProof", "release-proof.json"],
  ["recoverySupport", "recovery-support.json"],
  ["evidenceManifest", "evidence-manifest.json"],
];

function normalizedAuthorityDigest(value, label) {
  const raw = string(value, label);
  const matched = raw.match(/^(?:sha256:)?([a-f0-9]{64})$/);
  if (!matched) fail(`${label} is invalid`);
  return matched[1];
}

function fail(message) {
  throw new Error(`AI acceptance input manifest ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} fields are invalid`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} is required`);
  return value;
}

function sha256(value, label) {
  const checked = string(value, label);
  if (!SHA256.test(checked)) fail(`${label} must be lowercase SHA-256`);
  return checked;
}

function byteSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function hostPath(value, label) {
  const path = string(value, label);
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
  return resolve(path);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalAiAcceptanceInputManifest(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function manifestIdentity(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

async function regularFile(path, descriptor, label) {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be a regular file`);
  if (entry.size !== descriptor.byteSize) fail(`${label} byte size mismatch`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== descriptor.sha256) fail(`${label} SHA-256 mismatch`);
}

function memberName(value, label, nested) {
  const name = string(value, label);
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    (!nested && name.includes("/"))
  ) {
    fail(`${label} is not a canonical relative file name`);
  }
  return name;
}

function validateMembers(value, label, nested) {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${label} members are required`);
  let previous = "";
  return value.map((member, index) => {
    exactKeys(
      member,
      ["name", "sha256", "byteSize"],
      `${label} member ${index}`,
    );
    const checked = {
      name: memberName(member.name, `${label} member ${index} name`, nested),
      sha256: sha256(member.sha256, `${label} member ${index} SHA-256`),
      byteSize: byteSize(member.byteSize, `${label} member ${index} byte size`),
    };
    if (previous && previous.localeCompare(checked.name) >= 0) {
      fail(`${label} members must be strictly sorted`);
    }
    previous = checked.name;
    return checked;
  });
}

function directoryDigest(members) {
  return createHash("sha256")
    .update(
      members
        .map(
          (member) => `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
        )
        .join(""),
    )
    .digest("hex");
}

async function collectDirectoryMembers(root, nested, label) {
  let rootEntry;
  try {
    rootEntry = await lstat(root);
  } catch {
    fail(`${label} is missing`);
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
  const members = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = `${directory}${sep}${entry.name}`;
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) fail(`${label} must not contain symlinks`);
      if (entry.isDirectory()) {
        if (!nested) fail(`${label} must contain regular files only`);
        await visit(path);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        members.push({
          name,
          sha256: createHash("sha256").update(content).digest("hex"),
          byteSize: content.length,
        });
      } else {
        fail(`${label} must contain regular files only`);
      }
    }
  }
  await visit(root);
  return members.sort((left, right) => left.name.localeCompare(right.name));
}

export async function describeAiAcceptanceInputDirectory(
  path,
  label,
  { nested = false } = {},
) {
  const hostPathValue = hostPath(path, label);
  const members = await collectDirectoryMembers(hostPathValue, nested, label);
  if (members.length === 0) fail(`${label} must not be empty`);
  return {
    hostPath: hostPathValue,
    sha256: directoryDigest(members),
    byteSize: members.reduce((sum, member) => sum + member.byteSize, 0),
    members,
  };
}

async function directory(
  value,
  label,
  { nested = false, exactMemberNames } = {},
) {
  exactKeys(value, ["hostPath", "sha256", "byteSize", "members"], label);
  const descriptor = {
    hostPath: hostPath(value.hostPath, `${label} hostPath`),
    sha256: sha256(value.sha256, `${label} SHA-256`),
    byteSize: byteSize(value.byteSize, `${label} byte size`),
    members: validateMembers(value.members, label, nested),
  };
  if (exactMemberNames) {
    const names = descriptor.members.map((member) => member.name);
    if (
      names.length !== exactMemberNames.size ||
      names.some((name) => !exactMemberNames.has(name))
    ) {
      fail(`${label} exact-${exactMemberNames.size} member set is invalid`);
    }
  }
  const actual = await collectDirectoryMembers(
    descriptor.hostPath,
    nested,
    label,
  );
  if (JSON.stringify(actual) !== JSON.stringify(descriptor.members))
    fail(`${label} member identities mismatch`);
  if (
    actual.reduce((sum, member) => sum + member.byteSize, 0) !==
    descriptor.byteSize
  ) {
    fail(`${label} byte size mismatch`);
  }
  if (directoryDigest(actual) !== descriptor.sha256)
    fail(`${label} SHA-256 mismatch`);
  return descriptor;
}

async function file(value, label, { sourceCommit = false } = {}) {
  exactKeys(
    value,
    sourceCommit
      ? ["hostPath", "sha256", "byteSize", "sourceCommit"]
      : ["hostPath", "sha256", "byteSize"],
    label,
  );
  const descriptor = {
    hostPath: hostPath(value.hostPath, `${label} hostPath`),
    sha256: sha256(value.sha256, `${label} SHA-256`),
    byteSize: byteSize(value.byteSize, `${label} byte size`),
    ...(sourceCommit
      ? { sourceCommit: string(value.sourceCommit, `${label} source commit`) }
      : {}),
  };
  if (sourceCommit && !COMMIT.test(descriptor.sourceCommit))
    fail(`${label} source commit is invalid`);
  await regularFile(descriptor.hostPath, descriptor, label);
  return descriptor;
}

function delivery(value, allowedHttpsOrigins) {
  object(value, "modelPack delivery");
  const kind = string(value.kind, "modelPack delivery kind");
  if (kind === "host-local-cache") {
    exactKeys(value, ["kind"], "modelPack delivery");
    return { kind };
  }
  if (kind !== "host-controlled-https")
    fail("modelPack delivery kind is invalid");
  exactKeys(value, ["kind", "url"], "modelPack delivery");
  let url;
  try {
    url = new URL(string(value.url, "modelPack delivery URL"));
  } catch {
    fail("modelPack delivery URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowedHttpsOrigins.includes(url.origin)
  ) {
    fail(
      "modelPack delivery URL is not an allowed host-controlled HTTPS origin",
    );
  }
  return { kind, url: url.toString() };
}

function validateAuthorityReceipt(raw, candidateInput, windowsProofInput) {
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("acceptance authority receipt is not JSON");
  }
  if (raw !== `${JSON.stringify(canonicalize(receipt))}\n`)
    fail("acceptance authority receipt is not canonical JSON");
  exactKeys(
    receipt,
    [
      "candidate",
      "contract",
      "modelPack",
      "proofCompanion",
      "resources",
      "schemaVersion",
      "scope",
      "trustStatus",
      "visionCore",
      "windowsProof",
    ],
    "acceptance authority receipt",
  );
  if (
    receipt.schemaVersion !== AUTHORITY_SCHEMA ||
    receipt.scope !== "installed_windows_acceptance" ||
    receipt.trustStatus !== "verified_for_acceptance"
  ) {
    fail("acceptance authority receipt scope or trust status is invalid");
  }
  exactKeys(
    receipt.candidate,
    [
      "attestationBundleSha256",
      "embeddedManifestSha256",
      "sourceCommit",
      "subjectSha256",
      "trustedBuilderEvidenceSha256",
    ],
    "acceptance authority candidate",
  );
  for (const key of [
    "attestationBundleSha256",
    "embeddedManifestSha256",
    "subjectSha256",
    "trustedBuilderEvidenceSha256",
  ]) {
    sha256(receipt.candidate[key], `acceptance authority candidate ${key}`);
  }
  if (!COMMIT.test(receipt.candidate.sourceCommit))
    fail("acceptance authority candidate source commit is invalid");
  const candidateByName = Object.fromEntries(
    candidateInput.members.map((member) => [member.name, member]),
  );
  const archive = candidateInput.members.find((member) =>
    member.name.endsWith(".zip"),
  );
  if (
    archive.sha256 !== receipt.candidate.subjectSha256 ||
    candidateByName["candidate-manifest.json"].sha256 !==
      receipt.candidate.embeddedManifestSha256 ||
    candidateByName["github-build-provenance.sigstore.json"].sha256 !==
      receipt.candidate.attestationBundleSha256 ||
    candidateByName["trusted-builder-evidence.json"].sha256 !==
      receipt.candidate.trustedBuilderEvidenceSha256
  )
    fail("acceptance authority candidate does not bind exact-four input");
  exactKeys(
    receipt.windowsProof,
    [
      "authorityDescriptorSha256",
      "proofAttestationBundleSha256",
      "signedProofSha256",
      "trustedProofEvidenceSha256",
      "workflowSha",
    ],
    "acceptance authority Windows proof",
  );
  for (const key of [
    "authorityDescriptorSha256",
    "proofAttestationBundleSha256",
    "signedProofSha256",
    "trustedProofEvidenceSha256",
  ]) {
    normalizedAuthorityDigest(
      receipt.windowsProof[key],
      `acceptance authority Windows proof ${key}`,
    );
  }
  if (!COMMIT.test(receipt.windowsProof.workflowSha))
    fail("acceptance authority Windows proof workflow is invalid");
  const proofByName = Object.fromEntries(
    windowsProofInput.members.map((member) => [member.name, member]),
  );
  if (
    proofByName["precutover-ai-proof.json"].sha256 !==
      normalizedAuthorityDigest(
        receipt.windowsProof.signedProofSha256,
        "acceptance authority signed proof",
      ) ||
    proofByName["precutover-ai-proof.sigstore.json"].sha256 !==
      normalizedAuthorityDigest(
        receipt.windowsProof.proofAttestationBundleSha256,
        "acceptance authority proof attestation",
      ) ||
    proofByName["trusted-precutover-proof-evidence.json"].sha256 !==
      normalizedAuthorityDigest(
        receipt.windowsProof.trustedProofEvidenceSha256,
        "acceptance authority proof evidence",
      )
  )
    fail("acceptance authority Windows proof does not bind exact-three input");
  exactKeys(
    receipt.proofCompanion,
    ["archiveSha256", "descriptorSha256", "sourceCommit"],
    "acceptance authority proof companion",
  );
  sha256(
    receipt.proofCompanion.archiveSha256,
    "acceptance authority proof companion archive",
  );
  sha256(
    receipt.proofCompanion.descriptorSha256,
    "acceptance authority proof companion descriptor",
  );
  if (!COMMIT.test(receipt.proofCompanion.sourceCommit))
    fail("acceptance authority proof companion source commit is invalid");
  exactKeys(
    receipt.visionCore,
    ["recordedFixtureArchive", "runtimeArchive"],
    "acceptance authority Vision core",
  );
  for (const [key, format] of [
    ["runtimeArchive", "vending-vision-candidate-artifact/v3"],
    ["recordedFixtureArchive", "vending-vision-main-artifacts/v1"],
  ]) {
    const artifact = receipt.visionCore[key];
    exactKeys(
      artifact,
      ["format", "sha256", "sourceCommit"],
      `acceptance authority Vision core ${key}`,
    );
    if (
      artifact.format !== format ||
      !SHA256.test(artifact.sha256 ?? "") ||
      !COMMIT.test(artifact.sourceCommit ?? "") ||
      artifact.sourceCommit !== receipt.candidate.sourceCommit
    ) {
      fail(`acceptance authority Vision core ${key} identity is invalid`);
    }
  }
  if (
    receipt.visionCore.runtimeArchive.sha256 !== receipt.candidate.subjectSha256
  ) {
    fail("acceptance authority candidate runtime binding is invalid");
  }
  exactKeys(
    receipt.modelPack,
    ["archive", "descriptorSha256", "sourceRevision"],
    "acceptance authority model pack",
  );
  exactKeys(
    receipt.modelPack.archive,
    ["byteSize", "sha256"],
    "acceptance authority model archive",
  );
  sha256(
    receipt.modelPack.archive.sha256,
    "acceptance authority model archive SHA-256",
  );
  byteSize(
    receipt.modelPack.archive.byteSize,
    "acceptance authority model archive byte size",
  );
  sha256(
    receipt.modelPack.descriptorSha256,
    "acceptance authority model descriptor",
  );
  if (!COMMIT.test(receipt.modelPack.sourceRevision))
    fail("acceptance authority model source revision is invalid");
  exactKeys(
    receipt.resources,
    [
      "aiLockSha256",
      "runtimeDescriptorSha256",
      "sourceDescriptorSha256",
      "workerExecutableSha256",
    ],
    "acceptance authority resources",
  );
  for (const [key, value] of Object.entries(receipt.resources))
    sha256(value, `acceptance authority ${key}`);
  exactKeys(
    receipt.contract,
    ["bundleDigest", "manifestSha256", "protocol"],
    "acceptance authority contract",
  );
  sha256(receipt.contract.bundleDigest, "acceptance authority contract bundle");
  sha256(
    receipt.contract.manifestSha256,
    "acceptance authority contract manifest",
  );
  if (receipt.contract.protocol !== "vem.vision.v2")
    fail("acceptance authority contract protocol is invalid");
  return receipt;
}

function windowsJoin(...parts) {
  return parts.join("\\");
}

export function containedCalibrationSourcePath(root, path, label) {
  const windows = /^(?:[A-Za-z]:\\|\\\\)/.test(root);
  const paths = windows ? windowsPath : { isAbsolute, relative, resolve, sep };
  const checked = paths.resolve(path);
  const canonicalRoot = paths.resolve(root);
  const difference = paths.relative(canonicalRoot, checked);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(difference)
  )
    fail(`${label} must remain inside calibration source bundle`);
  return checked;
}

async function calibrationSourceBundle(value) {
  const bundle = await directory(value, "formal calibration source bundle", {
    nested: true,
  });
  const inputPath = resolve(bundle.hostPath, "calibration-source-input.json");
  let input;
  try {
    input = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    fail("calibration source bundle input is not JSON");
  }
  if (
    input?.schemaVersion !== "vem-ai-regional-evidence-calibration-input/v2" ||
    !isAbsolute(input.artifactRoot ?? "") ||
    !Array.isArray(input.attempts) ||
    input.attempts.length !== 2
  ) {
    fail("calibration source bundle input is invalid");
  }
  const inputRaw = await readFile(inputPath);
  if (inputRaw.toString("utf8") !== canonicalAiAcceptanceInputManifest(input))
    fail("calibration source bundle input is not canonical JSON");
  if (resolve(input.artifactRoot) !== bundle.hostPath)
    fail("calibration source bundle artifact root is invalid");
  const documents = [];
  for (const [key, name] of CALIBRATION_DOCUMENTS) {
    const reference = input[key];
    if (
      !reference ||
      Object.keys(reference).sort().join("\0") !== "path\0sha256" ||
      !isAbsolute(reference.path) ||
      !SHA256.test(reference.sha256 ?? "")
    ) {
      fail(`calibration source ${key} reference is invalid`);
    }
    const hostPath = containedCalibrationSourcePath(
      bundle.hostPath,
      reference.path,
      `calibration source ${key}`,
    );
    const descriptor = {
      hostPath,
      sha256: reference.sha256,
      byteSize: (await lstat(hostPath)).size,
    };
    await regularFile(hostPath, descriptor, `calibration source ${key}`);
    if (relative(bundle.hostPath, hostPath).split(sep).join("/") !== name)
      fail(`calibration source ${key} must use its canonical bundle member`);
    documents.push({ key, name, ...descriptor });
  }
  const sidecars = [];
  for (const entry of input.attempts) {
    const name = memberName(
      entry?.attempt?.regionalEvidence?.path,
      "calibration regional sidecar path",
      true,
    );
    const hostPath = containedCalibrationSourcePath(
      bundle.hostPath,
      resolve(input.artifactRoot, name),
      "calibration regional sidecar",
    );
    const descriptor = {
      hostPath,
      sha256: sha256(
        entry?.attempt?.regionalEvidence?.sha256,
        "calibration regional sidecar SHA-256",
      ),
      byteSize: (await lstat(hostPath)).size,
    };
    await regularFile(hostPath, descriptor, "calibration regional sidecar");
    sidecars.push({ name, ...descriptor });
  }
  if (new Set(sidecars.map((entry) => entry.name)).size !== 2)
    fail("calibration regional sidecars must be exact-two");
  let evidenceManifest;
  try {
    evidenceManifest = JSON.parse(
      await readFile(
        documents.find((entry) => entry.key === "evidenceManifest").hostPath,
        "utf8",
      ),
    );
  } catch {
    fail("calibration source evidence manifest is not JSON");
  }
  if (!Array.isArray(evidenceManifest.files))
    fail("calibration source evidence manifest files are invalid");
  for (const entry of evidenceManifest.files) {
    if (!entry || !isAbsolute(entry.path ?? ""))
      fail("calibration source evidence manifest path is invalid");
    containedCalibrationSourcePath(
      bundle.hostPath,
      entry.path,
      "calibration source evidence manifest path",
    );
  }
  const names = new Set([
    "calibration-source-input.json",
    ...documents.map((entry) =>
      relative(bundle.hostPath, entry.hostPath).split(sep).join("/"),
    ),
    ...sidecars.map((entry) => entry.name),
  ]);
  if (
    bundle.members.length !== 8 ||
    names.size !== 8 ||
    bundle.members.some((entry) => !names.has(entry.name))
  )
    fail("calibration source bundle must contain exact-eight closure files");
  return { bundle, documents, evidenceManifest, input, sidecars };
}

function guestProjection(artifacts, manifestSha256) {
  const root = windowsJoin(GUEST_ROOT, manifestSha256);
  const calibration =
    artifacts.phase === "formal"
      ? {
          calibratedRegionalPolicy: windowsJoin(
            root,
            "calibrated-regional-policy.json",
          ),
          calibrationReceipt: windowsJoin(root, "calibration-receipt.json"),
          calibrationSourceInput: windowsJoin(root, "calibration-source"),
        }
      : {};
  const identities = {
    manifestSha256,
    candidateInput: pickDirectory(artifacts.candidateInput),
    windowsProofInput: pickDirectory(artifacts.windowsProofInput),
    acceptanceAuthorityReceipt: pickFile(artifacts.acceptanceAuthorityReceipt),
    installedVisionRuntimeArchive: pickFile(
      artifacts.installedVisionRuntimeArchive,
      true,
    ),
    recordedFixtureArchive: pickFile(artifacts.recordedFixtureArchive, true),
    modelPackArchive: pickFile(artifacts.modelPack.archive),
    materializedModelPackRoot: pickDirectory(
      artifacts.modelPack.materializedRoot,
    ),
    ...(artifacts.phase === "formal"
      ? Object.fromEntries([
          [
            "calibratedRegionalPolicy",
            pickFile(artifacts.calibratedRegionalPolicy),
          ],
          ["calibrationReceipt", pickFile(artifacts.calibrationReceipt)],
          [
            "calibrationSourceInput",
            pickDirectory(artifacts.calibrationSourceInput),
          ],
        ])
      : {}),
  };
  return {
    schemaVersion: "vem-local-testbed-ai-virtual-try-on-input/v2",
    inputRoot: root,
    phase: artifacts.phase,
    candidateInputDirectory: windowsJoin(root, "candidate"),
    windowsProofInputDirectory: windowsJoin(root, "windows-proof"),
    acceptanceAuthorityReceipt: windowsJoin(
      root,
      "acceptance-authority-receipt.json",
    ),
    ...calibration,
    installedVisionRuntimeArchive: windowsJoin(root, "vision-runtime.zip"),
    recordedFixtureArchive: windowsJoin(root, "recorded-fixtures.zip"),
    modelPackArchive: windowsJoin(root, "model-pack.zip"),
    materializedModelPackRoot: windowsJoin(root, "model-pack"),
    modelPackSource: artifacts.modelPack.delivery.kind,
    ...(artifacts.modelPack.delivery.kind === "host-controlled-https"
      ? { modelPackUrl: artifacts.modelPack.delivery.url }
      : {}),
    modelPackSha256: artifacts.modelPack.archive.sha256,
    modelPackByteSize: artifacts.modelPack.archive.byteSize,
    identities,
  };
}

function pickFile(value, sourceCommit = false) {
  return {
    sha256: value.sha256,
    byteSize: value.byteSize,
    ...(sourceCommit ? { sourceCommit: value.sourceCommit } : {}),
  };
}

function pickDirectory(value) {
  return {
    sha256: value.sha256,
    byteSize: value.byteSize,
    members: value.members,
  };
}

export async function validateAiAcceptanceInputManifest(
  raw,
  { allowedHttpsOrigins = [] } = {},
) {
  if (typeof raw !== "string" || raw.length === 0)
    fail("raw document is required");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("is not JSON");
  }
  if (raw !== canonicalAiAcceptanceInputManifest(value))
    fail("is not canonical JSON");
  const phase = value.phase;
  if (phase !== "measurement" && phase !== "formal")
    fail("phase must be measurement or formal");
  const fields = [
    "acceptanceAuthorityReceipt",
    "candidateInput",
    "installedVisionRuntimeArchive",
    "modelPack",
    "phase",
    "recordedFixtureArchive",
    "schemaVersion",
    "windowsProofInput",
  ];
  if (phase === "formal") fields.push(...CALIBRATION_FIELDS);
  exactKeys(value, fields, "root");
  if (value.schemaVersion !== SCHEMA_VERSION)
    fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  const candidateInput = await directory(
    value.candidateInput,
    "candidate exact-four input",
    {
      exactMemberNames: new Set([
        ...CANDIDATE_MEMBERS,
        ...value.candidateInput.members
          .filter(
            (member) =>
              typeof member?.name === "string" && member.name.endsWith(".zip"),
          )
          .map((member) => member.name),
      ]),
    },
  );
  if (
    candidateInput.members.length !== 4 ||
    candidateInput.members.filter((member) => member.name.endsWith(".zip"))
      .length !== 1
  ) {
    fail("candidate exact-four archive set is invalid");
  }
  const windowsProofInput = await directory(
    value.windowsProofInput,
    "Windows proof exact-three input",
    { exactMemberNames: WINDOWS_PROOF_MEMBERS },
  );
  const acceptanceAuthorityReceipt = await file(
    value.acceptanceAuthorityReceipt,
    "acceptance authority receipt",
  );
  const authority = validateAuthorityReceipt(
    await readFile(acceptanceAuthorityReceipt.hostPath, "utf8"),
    candidateInput,
    windowsProofInput,
  );
  const installedVisionRuntimeArchive = await file(
    value.installedVisionRuntimeArchive,
    "installed Vision runtime archive",
    { sourceCommit: true },
  );
  if (
    installedVisionRuntimeArchive.sha256 !==
      authority.visionCore.runtimeArchive.sha256 ||
    installedVisionRuntimeArchive.sourceCommit !==
      authority.visionCore.runtimeArchive.sourceCommit
  ) {
    fail(
      "installed Vision runtime archive does not match acceptance authority",
    );
  }
  const recordedFixtureArchive = await file(
    value.recordedFixtureArchive,
    "recorded fixture archive",
    { sourceCommit: true },
  );
  if (
    recordedFixtureArchive.sha256 !==
      authority.visionCore.recordedFixtureArchive.sha256 ||
    recordedFixtureArchive.sourceCommit !==
      authority.visionCore.recordedFixtureArchive.sourceCommit
  ) {
    fail("recorded fixture archive does not match acceptance authority");
  }
  exactKeys(
    value.modelPack,
    ["archive", "delivery", "materializedRoot"],
    "modelPack",
  );
  const modelPack = {
    archive: await file(value.modelPack.archive, "official model pack archive"),
    materializedRoot: await directory(
      value.modelPack.materializedRoot,
      "materialized official model pack",
      { nested: true },
    ),
    delivery: delivery(value.modelPack.delivery, allowedHttpsOrigins),
  };
  if (
    modelPack.archive.sha256 !== authority.modelPack.archive.sha256 ||
    modelPack.archive.byteSize !== authority.modelPack.archive.byteSize
  ) {
    fail("official model pack does not match acceptance authority");
  }
  const calibrationSource =
    phase === "formal"
      ? await calibrationSourceBundle(value.calibrationSourceInput)
      : undefined;
  const calibration =
    phase === "formal"
      ? {
          calibratedRegionalPolicy: await file(
            value.calibratedRegionalPolicy,
            "formal calibratedRegionalPolicy",
          ),
          calibrationReceipt: await file(
            value.calibrationReceipt,
            "formal calibrationReceipt",
          ),
          calibrationSourceInput: calibrationSource.bundle,
        }
      : {};
  const manifestSha256 = manifestIdentity(raw);
  const artifacts = {
    acceptanceAuthorityReceipt,
    candidateInput,
    installedVisionRuntimeArchive,
    modelPack,
    phase,
    recordedFixtureArchive,
    windowsProofInput,
    ...calibration,
  };
  const guestInput = guestProjection(artifacts, manifestSha256);
  const transfers = [
    { ...candidateInput, guestPath: guestInput.candidateInputDirectory },
    { ...windowsProofInput, guestPath: guestInput.windowsProofInputDirectory },
    {
      ...acceptanceAuthorityReceipt,
      guestPath: guestInput.acceptanceAuthorityReceipt,
    },
    ...(phase === "formal"
      ? CALIBRATION_FIELDS.map((key) => ({
          ...calibration[key],
          guestPath: guestInput[key],
        }))
      : []),
    {
      ...installedVisionRuntimeArchive,
      guestPath: guestInput.installedVisionRuntimeArchive,
    },
    { ...recordedFixtureArchive, guestPath: guestInput.recordedFixtureArchive },
    { ...modelPack.archive, guestPath: guestInput.modelPackArchive },
    {
      ...modelPack.materializedRoot,
      guestPath: guestInput.materializedModelPackRoot,
    },
  ];
  return {
    acceptanceAuthorityReceipt: {
      ...acceptanceAuthorityReceipt,
      value: authority,
    },
    artifactDigests: guestInput.identities,
    candidateInput,
    guestInput,
    manifestSha256,
    transfers,
    windowsProofInput,
    ...(calibrationSource ? { calibrationSource } : {}),
  };
}

export async function materializeAiAcceptanceInputSnapshot(preparation, root) {
  const snapshotRoot = resolve(root, preparation.manifestSha256);
  const files = preparation.transfers.map((transfer) => [
    transfer.hostPath,
    transfer.guestPath.split("\\").at(-1),
  ]);
  await mkdir(snapshotRoot, { recursive: true });
  for (const [source, name] of files)
    await cp(source, resolve(snapshotRoot, name), {
      recursive: true,
      force: true,
    });
  let calibrationReceiptIdentity;
  let calibrationSourceIdentity;
  if (preparation.calibrationSource) {
    const bundleRoot = resolve(snapshotRoot, "calibration-source");
    const guestRoot = preparation.guestInput.calibrationSourceInput;
    const closure = preparation.calibrationSource;
    const manifestDocument = closure.documents.find(
      (entry) => entry.key === "evidenceManifest",
    );
    const manifestPath = resolve(
      bundleRoot,
      relative(closure.bundle.hostPath, manifestDocument.hostPath),
    );
    const manifest = structuredClone(closure.evidenceManifest);
    for (const entry of manifest.files) {
      entry.path = windowsJoin(
        guestRoot,
        ...relative(closure.bundle.hostPath, resolve(entry.path)).split(sep),
      );
    }
    const manifestRaw = canonicalAiAcceptanceInputManifest(manifest);
    await writeFile(manifestPath, manifestRaw);
    const rewritten = structuredClone(closure.input);
    rewritten.artifactRoot = guestRoot;
    for (const document of closure.documents) {
      rewritten[document.key] = {
        path: windowsJoin(
          guestRoot,
          ...relative(closure.bundle.hostPath, document.hostPath).split(sep),
        ),
        sha256:
          document.key === "evidenceManifest"
            ? manifestIdentity(manifestRaw)
            : document.sha256,
      };
    }
    const inputRaw = canonicalAiAcceptanceInputManifest(rewritten);
    await writeFile(
      resolve(bundleRoot, "calibration-source-input.json"),
      inputRaw,
    );
    const members = await collectDirectoryMembers(
      bundleRoot,
      true,
      "calibration source bundle",
    );
    calibrationSourceIdentity = {
      sha256: directoryDigest(members),
      byteSize: members.reduce((sum, member) => sum + member.byteSize, 0),
      members,
    };
    const receiptPath = resolve(snapshotRoot, "calibration-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.calibrationInputSha256 = manifestIdentity(inputRaw);
    const receiptRaw = canonicalAiAcceptanceInputManifest(receipt);
    await writeFile(receiptPath, receiptRaw);
    calibrationReceiptIdentity = {
      sha256: manifestIdentity(receiptRaw),
      byteSize: Buffer.byteLength(receiptRaw),
    };
  }
  const remapped = preparation.transfers.map((transfer, index) => ({
    ...transfer,
    hostPath: resolve(snapshotRoot, files[index][1]),
    ...(transfer.guestPath === preparation.guestInput.calibrationReceipt
      ? calibrationReceiptIdentity
      : {}),
    ...(transfer.guestPath === preparation.guestInput.calibrationSourceInput
      ? calibrationSourceIdentity
      : {}),
  }));
  return {
    ...preparation,
    transfers: remapped,
    artifactDigests: {
      ...preparation.artifactDigests,
      ...(calibrationReceiptIdentity
        ? { calibrationReceipt: calibrationReceiptIdentity }
        : {}),
      ...(calibrationSourceIdentity
        ? { calibrationSourceInput: calibrationSourceIdentity }
        : {}),
    },
    guestInput: {
      ...preparation.guestInput,
      identities: {
        ...preparation.guestInput.identities,
        ...(calibrationReceiptIdentity
          ? { calibrationReceipt: calibrationReceiptIdentity }
          : {}),
        ...(calibrationSourceIdentity
          ? { calibrationSourceInput: calibrationSourceIdentity }
          : {}),
      },
    },
  };
}

export async function materializeHostCalibrationSourceSnapshot(
  guestBundlePath,
  hostRoot,
) {
  const source = hostPath(guestBundlePath, "guest calibration source bundle");
  const destination = hostPath(hostRoot, "host calibration source bundle");
  await cp(source, destination, { recursive: true, errorOnExist: true });
  const inputPath = resolve(destination, "calibration-source-input.json");
  let input;
  try {
    input = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    fail("guest calibration source input is not JSON");
  }
  if (input?.schemaVersion !== "vem-ai-regional-evidence-calibration-input/v2")
    fail("guest calibration source input is invalid");
  const documents = Object.fromEntries(
    CALIBRATION_DOCUMENTS.map(([key, name]) => [
      key,
      resolve(destination, name),
    ]),
  );
  const manifest = JSON.parse(
    await readFile(documents.evidenceManifest, "utf8"),
  );
  for (const entry of manifest.files ?? []) {
    const windowsRelative = windowsPath.relative(
      input.artifactRoot,
      entry?.path ?? "",
    );
    const segments = windowsRelative.split(/[\\/]+/);
    if (
      segments.length === 0 ||
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    )
      fail("guest manifest member escapes calibration source bundle");
    const hostPath = resolve(destination, ...segments);
    const expected = entry?.sha256;
    const copied = await readFile(hostPath);
    if (!SHA256.test(expected ?? "") || manifestIdentity(copied) !== expected)
      fail("guest manifest member identity mismatched after copy");
    entry.path = hostPath;
  }
  const manifestRaw = canonicalAiAcceptanceInputManifest(manifest);
  await writeFile(documents.evidenceManifest, manifestRaw);
  input.artifactRoot = destination;
  for (const [key, path] of Object.entries(documents)) {
    const raw = await readFile(path);
    input[key] = { path, sha256: manifestIdentity(raw) };
  }
  const inputRaw = canonicalAiAcceptanceInputManifest(input);
  await writeFile(inputPath, inputRaw);
  return {
    artifactRoot: destination,
    inputPath,
    inputSha256: manifestIdentity(inputRaw),
  };
}

export function identicalAiAcceptanceInputSnapshot(left, right) {
  return (
    Boolean(left && right) &&
    left.manifestSha256 === right.manifestSha256 &&
    JSON.stringify(left.artifactDigests) ===
      JSON.stringify(right.artifactDigests)
  );
}
