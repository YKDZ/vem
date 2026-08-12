import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SCHEMA_VERSION = "vem-runtime-testbed-ai-input/v3";
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
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
        continue;
      }
      if (!entry.isFile()) fail(`${label} must contain regular files only`);
      const content = await readFile(path);
      members.push({
        name,
        sha256: createHash("sha256").update(content).digest("hex"),
        byteSize: content.length,
      });
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
  if (JSON.stringify(actual) !== JSON.stringify(descriptor.members)) {
    fail(`${label} member identities mismatch`);
  }
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
  if (sourceCommit && !COMMIT.test(descriptor.sourceCommit)) {
    fail(`${label} source commit is invalid`);
  }
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

function windowsJoin(...parts) {
  return parts.join("\\");
}

async function calibrationSourceClosure(source) {
  let input;
  try {
    input = JSON.parse(await readFile(source.hostPath, "utf8"));
  } catch {
    fail("calibration source input is not JSON");
  }
  if (
    input?.schemaVersion !== "vem-ai-regional-evidence-calibration-input/v1" ||
    !isAbsolute(input.artifactRoot ?? "") ||
    !Array.isArray(input.attempts) ||
    input.attempts.length !== 2
  ) {
    fail("calibration source input identity is invalid");
  }
  const references = [
    ["acceptanceReport", "acceptance-report.json"],
    ["precutoverReceipt", "precutover-receipt.json"],
    ["releaseProof", "release-proof.json"],
    ["recoverySupport", "recovery-support.json"],
    ["evidenceManifest", "evidence-manifest.json"],
  ];
  const documents = [];
  for (const [key, name] of references) {
    const reference = input[key];
    if (
      !reference ||
      Object.keys(reference).sort().join("\0") !== "path\0sha256" ||
      !isAbsolute(reference.path) ||
      !SHA256.test(reference.sha256 ?? "")
    ) {
      fail(`calibration source ${key} reference is invalid`);
    }
    const descriptor = {
      hostPath: resolve(reference.path),
      sha256: reference.sha256,
      byteSize: (await lstat(reference.path)).size,
    };
    await regularFile(
      descriptor.hostPath,
      descriptor,
      `calibration source ${key}`,
    );
    documents.push({ key, name, ...descriptor });
  }
  const sidecars = [];
  for (const entry of input.attempts) {
    const relativePath = memberName(
      entry?.attempt?.regionalEvidence?.path,
      "calibration regional sidecar path",
      true,
    );
    const descriptor = {
      hostPath: resolve(input.artifactRoot, relativePath),
      sha256: sha256(
        entry?.attempt?.regionalEvidence?.sha256,
        "calibration regional sidecar SHA-256",
      ),
      byteSize: (await lstat(resolve(input.artifactRoot, relativePath))).size,
    };
    await regularFile(
      descriptor.hostPath,
      descriptor,
      "calibration regional sidecar",
    );
    sidecars.push({ name: relativePath, ...descriptor });
  }
  if (new Set(sidecars.map((entry) => entry.name)).size !== 2) {
    fail("calibration regional sidecars must be exact-two");
  }
  return { input, documents, sidecars };
}

function guestProjection(
  {
    candidateInput,
    windowsProofInput,
    approvedPrecutoverReceipt,
    calibratedRegionalPolicy,
    calibrationReceipt,
    calibrationSourceInput,
    installedVisionRuntimeArchive,
    recordedFixtureArchive,
    modelPack,
  },
  manifestSha256,
) {
  const root = windowsJoin(GUEST_ROOT, manifestSha256);
  const calibrationSourceRoot = windowsJoin(root, "calibration-source");
  return {
    schemaVersion: "vem-local-testbed-ai-virtual-try-on-input/v1",
    inputRoot: root,
    candidateInputDirectory: windowsJoin(root, "candidate"),
    windowsProofInputDirectory: windowsJoin(root, "windows-proof"),
    approvedPrecutoverReceipt: windowsJoin(root, "approved-receipt.json"),
    calibratedRegionalPolicy: windowsJoin(
      root,
      "calibrated-regional-policy.json",
    ),
    calibrationReceipt: windowsJoin(root, "calibration-receipt.json"),
    calibrationSourceRoot,
    calibrationSourceInput: windowsJoin(
      calibrationSourceRoot,
      "calibration-source-input.json",
    ),
    installedVisionRuntimeArchive: windowsJoin(root, "vision-runtime.zip"),
    recordedFixtureArchive: windowsJoin(root, "recorded-fixtures.zip"),
    modelPackArchive: windowsJoin(root, "model-pack.zip"),
    materializedModelPackRoot: windowsJoin(root, "model-pack"),
    modelPackSource: modelPack.delivery.kind,
    ...(modelPack.delivery.kind === "host-controlled-https"
      ? { modelPackUrl: modelPack.delivery.url }
      : {}),
    modelPackSha256: modelPack.archive.sha256,
    modelPackByteSize: modelPack.archive.byteSize,
    identities: {
      manifestSha256,
      candidateInput: {
        sha256: candidateInput.sha256,
        byteSize: candidateInput.byteSize,
        members: candidateInput.members,
      },
      windowsProofInput: {
        sha256: windowsProofInput.sha256,
        byteSize: windowsProofInput.byteSize,
        members: windowsProofInput.members,
      },
      approvedPrecutoverReceipt: {
        sha256: approvedPrecutoverReceipt.sha256,
        byteSize: approvedPrecutoverReceipt.byteSize,
      },
      calibratedRegionalPolicy: {
        sha256: calibratedRegionalPolicy.sha256,
        byteSize: calibratedRegionalPolicy.byteSize,
      },
      calibrationReceipt: {
        sha256: calibrationReceipt.sha256,
        byteSize: calibrationReceipt.byteSize,
      },
      calibrationSourceInput: {
        sha256: calibrationSourceInput.sha256,
        byteSize: calibrationSourceInput.byteSize,
      },
      installedVisionRuntimeArchive: {
        sha256: installedVisionRuntimeArchive.sha256,
        byteSize: installedVisionRuntimeArchive.byteSize,
        sourceCommit: installedVisionRuntimeArchive.sourceCommit,
      },
      recordedFixtureArchive: {
        sha256: recordedFixtureArchive.sha256,
        byteSize: recordedFixtureArchive.byteSize,
      },
      modelPackArchive: {
        sha256: modelPack.archive.sha256,
        byteSize: modelPack.archive.byteSize,
      },
      materializedModelPackRoot: {
        sha256: modelPack.materializedRoot.sha256,
        byteSize: modelPack.materializedRoot.byteSize,
        members: modelPack.materializedRoot.members,
      },
    },
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
  exactKeys(
    value,
    [
      "schemaVersion",
      "candidateInput",
      "windowsProofInput",
      "approvedPrecutoverReceipt",
      "calibratedRegionalPolicy",
      "calibrationReceipt",
      "calibrationSourceInput",
      "installedVisionRuntimeArchive",
      "recordedFixtureArchive",
      "modelPack",
    ],
    "root",
  );
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
  const candidateArchives = candidateInput.members.filter((member) =>
    member.name.endsWith(".zip"),
  );
  if (candidateArchives.length !== 1 || candidateInput.members.length !== 4) {
    fail("candidate exact-four archive set is invalid");
  }
  const windowsProofInput = await directory(
    value.windowsProofInput,
    "Windows proof exact-three input",
    { exactMemberNames: WINDOWS_PROOF_MEMBERS },
  );
  const approvedPrecutoverReceipt = await file(
    value.approvedPrecutoverReceipt,
    "B2 approved receipt",
  );
  const calibratedRegionalPolicy = await file(
    value.calibratedRegionalPolicy,
    "calibrated AI regional evidence policy",
  );
  const calibrationReceipt = await file(
    value.calibrationReceipt,
    "calibrated AI regional evidence receipt",
  );
  const calibrationSourceInput = await file(
    value.calibrationSourceInput,
    "calibration source input",
  );
  const calibrationSource = await calibrationSourceClosure(
    calibrationSourceInput,
  );
  let receipt;
  try {
    receipt = JSON.parse(
      await readFile(approvedPrecutoverReceipt.hostPath, "utf8"),
    );
  } catch {
    fail("B2 approved receipt is not JSON");
  }
  if (
    receipt?.schemaVersion !== "vem.precutover.ai.v2" ||
    receipt?.trustStatus !== "pending_final_aggregate_approval"
  ) {
    fail("B2 approved receipt identity is invalid");
  }
  const installedVisionRuntimeArchive = await file(
    value.installedVisionRuntimeArchive,
    "installed Vision runtime archive",
    { sourceCommit: true },
  );
  const recordedFixtureArchive = await file(
    value.recordedFixtureArchive,
    "recorded fixture archive",
  );
  exactKeys(
    value.modelPack,
    ["archive", "materializedRoot", "delivery"],
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
  const manifestSha256 = manifestIdentity(raw);
  const artifacts = {
    candidateInput,
    windowsProofInput,
    approvedPrecutoverReceipt,
    calibratedRegionalPolicy,
    calibrationReceipt,
    calibrationSourceInput,
    calibrationSource,
    installedVisionRuntimeArchive,
    recordedFixtureArchive,
    modelPack,
  };
  const projection = guestProjection(artifacts, manifestSha256);
  return {
    manifestSha256,
    calibrationSource,
    artifactDigests: projection.identities,
    guestInput: projection,
    transfers: [
      { ...candidateInput, guestPath: projection.candidateInputDirectory },
      {
        ...windowsProofInput,
        guestPath: projection.windowsProofInputDirectory,
      },
      {
        ...approvedPrecutoverReceipt,
        guestPath: projection.approvedPrecutoverReceipt,
      },
      {
        ...calibratedRegionalPolicy,
        guestPath: projection.calibratedRegionalPolicy,
      },
      { ...calibrationReceipt, guestPath: projection.calibrationReceipt },
      {
        ...calibrationSourceInput,
        guestPath: projection.calibrationSourceInput,
      },
      {
        ...installedVisionRuntimeArchive,
        guestPath: projection.installedVisionRuntimeArchive,
      },
      {
        ...recordedFixtureArchive,
        guestPath: projection.recordedFixtureArchive,
      },
      { ...modelPack.archive, guestPath: projection.modelPackArchive },
      {
        ...modelPack.materializedRoot,
        guestPath: projection.materializedModelPackRoot,
      },
    ],
  };
}

export async function materializeAiAcceptanceInputSnapshot(preparation, root) {
  const snapshotRoot = resolve(root, preparation.manifestSha256);
  const files = [
    [preparation.transfers[0].hostPath, "candidate"],
    [preparation.transfers[1].hostPath, "windows-proof"],
    [preparation.transfers[2].hostPath, "approved-receipt.json"],
    [preparation.transfers[3].hostPath, "calibrated-regional-policy.json"],
    [preparation.transfers[4].hostPath, "calibration-receipt.json"],
    [null, "calibration-source"],
    [preparation.transfers[6].hostPath, "vision-runtime.zip"],
    [preparation.transfers[7].hostPath, "recorded-fixtures.zip"],
    [preparation.transfers[8].hostPath, "model-pack.zip"],
    [preparation.transfers[9].hostPath, "model-pack"],
  ];
  await mkdir(snapshotRoot, { recursive: true });
  for (const [source, name] of files) {
    if (source === null) continue;
    await cp(source, resolve(snapshotRoot, name), {
      recursive: true,
      force: true,
    });
  }
  const bundleRoot = resolve(snapshotRoot, "calibration-source");
  await mkdir(bundleRoot, { recursive: true });
  const closure = preparation.calibrationSource;
  for (const document of closure.documents) {
    await cp(document.hostPath, resolve(bundleRoot, document.name), {
      force: true,
    });
  }
  for (const sidecar of closure.sidecars) {
    const destination = resolve(bundleRoot, sidecar.name);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(sidecar.hostPath, destination, { force: true });
  }
  const guestRoot = preparation.guestInput.calibrationSourceRoot;
  const manifestDocument = closure.documents.find(
    (entry) => entry.key === "evidenceManifest",
  );
  const manifestPath = resolve(bundleRoot, manifestDocument.name);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const file of manifest.files ?? []) {
    const sidecar = closure.sidecars.find(
      (entry) => resolve(file.path) === entry.hostPath,
    );
    if (sidecar) file.path = windowsJoin(guestRoot, ...sidecar.name.split("/"));
  }
  const manifestRaw = canonicalAiAcceptanceInputManifest(manifest);
  await writeFile(manifestPath, manifestRaw);
  const rewritten = structuredClone(closure.input);
  rewritten.artifactRoot = guestRoot;
  for (const document of closure.documents) {
    rewritten[document.key] = {
      path: windowsJoin(guestRoot, document.name),
      sha256:
        document.key === "evidenceManifest"
          ? manifestIdentity(manifestRaw)
          : document.sha256,
    };
  }
  const inputRaw = canonicalAiAcceptanceInputManifest(rewritten);
  const inputPath = resolve(bundleRoot, "calibration-source-input.json");
  await writeFile(inputPath, inputRaw);
  const bundleMembers = await collectDirectoryMembers(
    bundleRoot,
    true,
    "calibration source bundle",
  );
  if (bundleMembers.length !== 8)
    fail("calibration source bundle must contain exact-eight files");
  const bundleIdentity = {
    sha256: directoryDigest(bundleMembers),
    byteSize: bundleMembers.reduce((sum, member) => sum + member.byteSize, 0),
    members: bundleMembers,
  };
  const receiptPath = resolve(snapshotRoot, "calibration-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.calibrationInputSha256 = manifestIdentity(inputRaw);
  const receiptRaw = canonicalAiAcceptanceInputManifest(receipt);
  await writeFile(receiptPath, receiptRaw);
  const receiptIdentity = {
    sha256: manifestIdentity(receiptRaw),
    byteSize: Buffer.byteLength(receiptRaw),
  };
  const remapped = {
    ...preparation,
    transfers: preparation.transfers.map((transfer, index) => ({
      ...transfer,
      hostPath: resolve(snapshotRoot, files[index][1]),
      ...(index === 4 ? receiptIdentity : {}),
      ...(index === 5
        ? {
            ...bundleIdentity,
            guestPath: preparation.guestInput.calibrationSourceRoot,
          }
        : {}),
    })),
    artifactDigests: {
      ...preparation.artifactDigests,
      calibrationReceipt: receiptIdentity,
      calibrationSourceInput: {
        sha256: manifestIdentity(inputRaw),
        byteSize: Buffer.byteLength(inputRaw),
      },
      calibrationSource: bundleIdentity,
    },
    guestInput: {
      ...preparation.guestInput,
      identities: {
        ...preparation.guestInput.identities,
        calibrationReceipt: receiptIdentity,
        calibrationSourceInput: {
          sha256: manifestIdentity(inputRaw),
          byteSize: Buffer.byteLength(inputRaw),
        },
        calibrationSource: bundleIdentity,
      },
    },
  };
  return remapped;
}

export function identicalAiAcceptanceInputSnapshot(left, right) {
  return (
    Boolean(left && right) &&
    left.manifestSha256 === right.manifestSha256 &&
    JSON.stringify(left.artifactDigests) ===
      JSON.stringify(right.artifactDigests)
  );
}
