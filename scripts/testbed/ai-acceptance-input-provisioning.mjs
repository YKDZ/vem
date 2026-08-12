import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
      "companion",
      "contract",
      "modelPack",
      "resources",
      "schemaVersion",
      "scope",
      "trustStatus",
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
    const value = string(
      receipt.windowsProof[key],
      `acceptance authority Windows proof ${key}`,
    );
    if (
      !/^sha256:/.test(value)
        ? !SHA256.test(value)
        : !/^sha256:[a-f0-9]{64}$/.test(value)
    )
      fail(`acceptance authority Windows proof ${key} is invalid`);
  }
  if (!COMMIT.test(receipt.windowsProof.workflowSha))
    fail("acceptance authority Windows proof workflow is invalid");
  const proofByName = Object.fromEntries(
    windowsProofInput.members.map((member) => [member.name, member]),
  );
  if (
    proofByName["precutover-ai-proof.json"].sha256 !==
      receipt.windowsProof.signedProofSha256 ||
    proofByName["precutover-ai-proof.sigstore.json"].sha256 !==
      receipt.windowsProof.proofAttestationBundleSha256 ||
    proofByName["trusted-precutover-proof-evidence.json"].sha256 !==
      receipt.windowsProof.trustedProofEvidenceSha256
  )
    fail("acceptance authority Windows proof does not bind exact-three input");
  exactKeys(
    receipt.companion,
    ["archiveSha256", "descriptorSha256", "sourceCommit"],
    "acceptance authority companion",
  );
  sha256(
    receipt.companion.archiveSha256,
    "acceptance authority companion archive",
  );
  sha256(
    receipt.companion.descriptorSha256,
    "acceptance authority companion descriptor",
  );
  if (!COMMIT.test(receipt.companion.sourceCommit))
    fail("acceptance authority companion source commit is invalid");
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
          calibrationSourceInput: windowsJoin(
            root,
            "calibration-source-input.json",
          ),
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
      ? Object.fromEntries(
          CALIBRATION_FIELDS.map((key) => [key, pickFile(artifacts[key])]),
        )
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
      authority.candidate.subjectSha256 ||
    installedVisionRuntimeArchive.sourceCommit !==
      authority.candidate.sourceCommit
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
    recordedFixtureArchive.sha256 !== authority.companion.archiveSha256 ||
    recordedFixtureArchive.sourceCommit !== authority.companion.sourceCommit
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
  const calibration =
    phase === "formal"
      ? Object.fromEntries(
          await Promise.all(
            CALIBRATION_FIELDS.map(async (key) => [
              key,
              await file(value[key], `formal ${key}`),
            ]),
          ),
        )
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
  };
}

export async function materializeAiAcceptanceInputSnapshot(preparation, root) {
  const snapshotRoot = resolve(root, preparation.manifestSha256);
  const files = preparation.transfers.map((transfer) => {
    const name = transfer.guestPath.split("\\").at(-1);
    return [transfer.hostPath, name];
  });
  await mkdir(snapshotRoot, { recursive: true });
  for (const [source, name] of files)
    await cp(source, resolve(snapshotRoot, name), {
      recursive: true,
      force: true,
    });
  const remapped = preparation.transfers.map((transfer, index) => ({
    ...transfer,
    hostPath: resolve(snapshotRoot, files[index][1]),
  }));
  return { ...preparation, transfers: remapped };
}

export function identicalAiAcceptanceInputSnapshot(left, right) {
  return (
    Boolean(left && right) &&
    left.manifestSha256 === right.manifestSha256 &&
    JSON.stringify(left.artifactDigests) ===
      JSON.stringify(right.artifactDigests)
  );
}
