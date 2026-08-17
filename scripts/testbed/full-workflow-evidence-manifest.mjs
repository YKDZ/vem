import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

export const EVIDENCE_LIMITS = Object.freeze({
  reportPerFileBytes: 2 * 1024 * 1024,
  tracePerTrackBytes: 512 * 1024,
  logPerFileBytes: 4 * 1024 * 1024,
  screenshotPerFileBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});

const REQUIRED_KINDS = Object.freeze(["machineRuntimeTrace", "logs"]);
const DEFAULT_EVIDENCE_POLICY = Object.freeze({
  passed: Object.freeze({ trace: true, logs: true, screenshot: false }),
  failed: Object.freeze({
    primaryReason: true,
    diagnostic: true,
    trace: false,
    logs: false,
    screenshot: false,
  }),
});
const FORBIDDEN_EXTENSIONS = new Set([
  ".avi",
  ".bin",
  ".bmp",
  ".dll",
  ".exe",
  ".gif",
  ".iso",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".qcow2",
  ".tiff",
  ".wav",
  ".webm",
  ".zip",
]);
export const AI_SUPPORT_EVIDENCE_SCHEMA =
  "vem.testbed.ai-virtual-try-on-support.v1";
const AI_SUPPORT_KINDS = new Set([
  "degradation-diagnostic",
  "installed-runtime",
  "regional-evidence",
  "resource-observation",
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FORBIDDEN_MAGIC = Object.freeze([
  ["PE", Buffer.from("MZ")],
  ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ["Mach-O", Buffer.from([0xfe, 0xed, 0xfa, 0xce])],
  ["Mach-O", Buffer.from([0xfe, 0xed, 0xfa, 0xcf])],
  ["Mach-O", Buffer.from([0xce, 0xfa, 0xed, 0xfe])],
  ["Mach-O", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
  ["Mach-O", Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
  ["Mach-O", Buffer.from([0xbe, 0xba, 0xfe, 0xca])],
  ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["ZIP", Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  ["ZIP", Buffer.from([0x50, 0x4b, 0x07, 0x08])],
  ["CAB", Buffer.from("MSCF")],
  ["ar", Buffer.from("!<arch>\n")],
  ["gzip", Buffer.from([0x1f, 0x8b])],
  ["7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ["RAR", Buffer.from("Rar!")],
  ["XZ", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
  ["bzip2", Buffer.from("BZh")],
  ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
  ["BMP", Buffer.from("BM")],
  ["ICO", Buffer.from([0x00, 0x00, 0x01, 0x00])],
  ["GIF", Buffer.from("GIF87a")],
  ["GIF", Buffer.from("GIF89a")],
  ["RIFF media", Buffer.from("RIFF")],
  ["MP3", Buffer.from("ID3")],
  ["Ogg", Buffer.from("OggS")],
  ["FLAC", Buffer.from("fLaC")],
  ["WebM", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
]);

function pathStaysWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  const declaredRoot = resolve(path);
  const rootStat = lstatSync(declaredRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error(
      `non-regular or linked evidence artifact root: ${declaredRoot}`,
    );
  const canonicalRoot = realpathSync(declaredRoot);
  const visit = (candidate) => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink())
      throw new Error(`non-regular or linked evidence artifact: ${candidate}`);
    const canonical = realpathSync(candidate);
    if (!pathStaysWithin(canonicalRoot, canonical))
      throw new Error(`evidence artifact escapes its root: ${candidate}`);
    if (stat.isFile()) return [resolve(candidate)];
    if (!stat.isDirectory())
      throw new Error(`non-regular or linked evidence artifact: ${candidate}`);
    return readdirSync(candidate, { withFileTypes: true }).flatMap((entry) =>
      visit(resolve(candidate, entry.name)),
    );
  };
  return visit(declaredRoot);
}

function requireRegularUnlinkedFile(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${label} must be a regular non-linked file: ${path}`);
}

function bytesRecord(path, kind, track) {
  const content = readFileSync(path);
  return {
    path,
    track,
    kind,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function virtualRecord(reportPath, jsonPath, kind, track, value) {
  const content = Buffer.from(JSON.stringify(value));
  return {
    path: `${reportPath}#${jsonPath}`,
    track,
    kind,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function meaningfulLog(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !value.error &&
    Object.keys(value).length > 0
  );
}

function primaryFailureReason(report) {
  const candidates = [
    report?.errors?.primary,
    report?.failure?.primaryReason,
    report?.failure?.message,
    report?.error,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (value && typeof value === "object") {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const message =
        typeof value.message === "string" ? value.message.trim() : "";
      if (name && message) return `${name}: ${message}`;
      if (message || name) return message || name;
    }
  }
  return null;
}

function isPng(path) {
  const signature = readFileSync(path).subarray(0, 8);
  return signature.equals(PNG_SIGNATURE);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value != null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
}

function forbiddenMagic(content) {
  for (const [label, signature] of FORBIDDEN_MAGIC) {
    if (content.subarray(0, signature.length).equals(signature)) return label;
  }
  if (
    content.byteLength >= 12 &&
    content.subarray(4, 8).equals(Buffer.from("ftyp"))
  )
    return "MP4";
  if (
    content.byteLength >= 262 &&
    content.subarray(257, 262).equals(Buffer.from("ustar"))
  )
    return "tar";
  if (
    content.byteLength >= 2 &&
    content[0] === 0xff &&
    (content[1] & 0xe0) === 0xe0
  )
    return "MPEG audio";
  if (content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return "PNG";
  return null;
}

function validateAiSupportingJson(path) {
  const content = readFileSync(path);
  const magic = forbiddenMagic(content);
  if (magic)
    return `disguised executable or archive/media (${magic}) in AI evidence artifact: ${path}`;
  let value;
  try {
    const raw = content.toString("utf8");
    value = JSON.parse(raw);
    if (`${JSON.stringify(canonicalJson(value))}\n` !== raw)
      return `noncanonical AI supporting JSON artifact: ${path}`;
  } catch {
    return `invalid AI supporting JSON artifact: ${path}`;
  }
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![AI_SUPPORT_EVIDENCE_SCHEMA, "vem-ai-regional-evidence/v1"].includes(
      value.schemaVersion,
    ) ||
    !AI_SUPPORT_KINDS.has(value.kind) ||
    (value.schemaVersion === AI_SUPPORT_EVIDENCE_SCHEMA &&
      (value.facts == null ||
        typeof value.facts !== "object" ||
        Array.isArray(value.facts) ||
        JSON.stringify(Object.keys(value).sort()) !==
          JSON.stringify(["facts", "kind", "schemaVersion"]))) ||
    (value.schemaVersion === "vem-ai-regional-evidence/v1" &&
      value.kind !== "regional-evidence")
  )
    return `unsupported AI supporting JSON schema: ${path}`;
  return null;
}

function disguisedArtifact(path) {
  if (extname(path).toLowerCase() === ".png") return null;
  const magic = forbiddenMagic(readFileSync(path));
  return magic
    ? `disguised executable or archive/media (${magic}) in evidence artifact: ${path}`
    : null;
}

function reportTrace(track, reportPath, report, artifactFiles) {
  const direct = {
    sale: ["runtimeTrace", report?.runtimeTrace],
    scannerPayment: ["runtimeTrace", report?.runtimeTrace],
    visionExperience: ["runtimeTrace", report?.runtimeTrace],
    aiVirtualTryOn: ["runtimeTrace", report?.runtimeTrace],
    presenceAndAudio: [
      "presenceAndAudio.runtimeTrace",
      report?.presenceAndAudio?.runtimeTrace,
    ],
    ipcRecovery: [
      "ipcRecovery.provenance.ui",
      [
        ...(report?.ipcRecovery?.provenance?.ui?.before?.runtimeTrace ?? []),
        ...(report?.ipcRecovery?.provenance?.ui?.after?.runtimeTrace ?? []),
      ],
    ],
    fulfillmentRecovery: ["evidence.ui.trace", report?.evidence?.ui?.trace],
  }[track];
  if (direct && nonEmptyArray(direct[1])) {
    return virtualRecord(
      reportPath,
      direct[0],
      "machineRuntimeTrace",
      track,
      direct[1],
    );
  }
  if (track === "pickupProtocol") {
    const path = artifactFiles.find(
      (candidate) => basename(candidate) === "machine-production-evidence.json",
    );
    if (path) {
      try {
        const evidence = JSON.parse(readFileSync(path, "utf8"));
        if (
          evidence?.schemaVersion === "machine-production-evidence/v2" &&
          evidence?.source === "installed_canonical_machine_cdp" &&
          nonEmptyArray(evidence.runtimeTrace)
        ) {
          return virtualRecord(
            path,
            "runtimeTrace",
            "machineRuntimeTrace",
            track,
            evidence.runtimeTrace,
          );
        }
      } catch {}
    }
  }
  return null;
}

function reportLog(track, reportPath, report) {
  const source = {
    scannerPayment: ["serial.rawFrames", report?.serial?.rawFrames],
    ipcRecovery: ["serial.rawFrames", report?.serial?.rawFrames],
    fulfillmentRecovery: [
      "evidence.platformLog",
      report?.evidence?.platformLog,
    ],
  }[track];
  if (!source || !meaningfulLog(source[1])) return null;
  return virtualRecord(reportPath, source[0], "logs", track, source[1]);
}

function physicalEvidence(track, artifactFiles) {
  const supporting = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".json")
    .map((path) => bytesRecord(path, "supportingEvidence", track));
  const logs = artifactFiles
    .filter((path) => {
      const extension = extname(path).toLowerCase();
      return (
        [".log", ".txt"].includes(extension) ||
        (track === "presenceAndAudio" && extension === ".wav")
      );
    })
    .map((path) => bytesRecord(path, "logs", track))
    .filter((record) => record.byteLength > 0);
  const screenshotCandidates = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".png" && isPng(path))
    .map((path) => bytesRecord(path, "screenshots", track));
  const screenshotScore = (record) => {
    const name = basename(record.path).toLowerCase();
    if (name.includes("failure")) return 4;
    if (name.includes("terminal")) return 3;
    if (name.includes("result")) return 2;
    if (name.includes("final")) return 1;
    return 0;
  };
  const selectedScreenshots = screenshotCandidates
    .sort(
      (left, right) =>
        screenshotScore(right) - screenshotScore(left) ||
        right.path.localeCompare(left.path),
    )
    .slice(0, track === "aiVirtualTryOn" ? 4 : 3);
  return {
    supporting,
    logs,
    screenshots: screenshotCandidates,
    selectedScreenshots,
  };
}

function validateAiReportScreenshots(report, artifactRoot, evidence, files) {
  if (
    report?.schemaVersion !== "vem-ai-virtual-try-on-acceptance/v2" ||
    report?.ok !== true
  )
    return null;
  const expected = report?.attempts?.flatMap(
    (attempt) => attempt.screenshots ?? [],
  );
  if (!Array.isArray(expected) || expected.length !== 4)
    return "AI virtual try-on report screenshots are incomplete";
  const actual = evidence.screenshots;
  if (!Array.isArray(actual) || actual.length !== 4)
    return "AI virtual try-on manifest screenshots are incomplete";
  for (const screenshot of expected) {
    const path = resolve(artifactRoot, screenshot.path);
    const record = files.find(
      (file) =>
        file.kind === "screenshots" &&
        file.path === path &&
        file.byteLength === screenshot.byteLength &&
        file.sha256 === screenshot.sha256,
    );
    if (!record || !actual.includes(record.path))
      return "AI virtual try-on manifest screenshots do not bind report screenshots";
  }
  return null;
}

function perFileLimit(file) {
  if (file.kind === "reports") return EVIDENCE_LIMITS.reportPerFileBytes;
  if (file.kind === "supportingEvidence")
    return EVIDENCE_LIMITS.reportPerFileBytes;
  if (file.kind === "machineRuntimeTrace")
    return EVIDENCE_LIMITS.tracePerTrackBytes;
  if (file.kind === "logs") return EVIDENCE_LIMITS.logPerFileBytes;
  return EVIDENCE_LIMITS.screenshotPerFileBytes;
}

export function buildFullWorkflowEvidenceManifest({ tracks = [] } = {}) {
  const failures = [];
  const blockingFailures = [];
  const files = [];
  const sections = [];
  const trackEvidence = [];
  for (const input of tracks) {
    const track = input?.key;
    const reportPath = resolve(input?.reportPath ?? "");
    const artifactRoot = input?.artifactRoot
      ? resolve(input?.artifactRoot)
      : null;
    if (!track || !existsSync(reportPath)) {
      blockingFailures.push(
        `required report artifact is absent for ${track ?? "unknown"}`,
      );
      continue;
    }
    let report;
    try {
      requireRegularUnlinkedFile(reportPath, "required report artifact");
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (error) {
      blockingFailures.push(
        error instanceof Error
          ? `required report artifact is invalid for ${track}: ${error.message}`
          : `required report artifact is invalid for ${track}`,
      );
      continue;
    }
    const businessStatus =
      input?.result?.businessStatus === "failed" ? "failed" : "passed";
    const evidencePolicy =
      input?.evidence?.[businessStatus] ??
      DEFAULT_EVIDENCE_POLICY[businessStatus];
    let artifactFiles = [];
    if (!artifactRoot || !existsSync(artifactRoot)) {
      failures.push(`actual artifact root is absent for ${track}`);
    } else {
      try {
        artifactFiles = filesUnder(artifactRoot);
      } catch (error) {
        blockingFailures.push(
          error instanceof Error
            ? error.message
            : `invalid evidence artifact tree for ${track}`,
        );
      }
    }
    for (const path of artifactFiles) {
      const extension = extname(path).toLowerCase();
      const allowedWav =
        track === "presenceAndAudio" && extension === ".wav";
      if (
        track === "aiVirtualTryOn" &&
        ![".json", ".log", ".png"].includes(extension)
      ) {
        blockingFailures.push(
          `forbidden AI evidence artifact for ${track}: ${path}`,
        );
      } else if (FORBIDDEN_EXTENSIONS.has(extension) && !allowedWav) {
        blockingFailures.push(
          `forbidden evidence artifact for ${track}: ${path}`,
        );
      } else if (track === "aiVirtualTryOn" && extension === ".json") {
        const invalidJson = validateAiSupportingJson(path);
        if (invalidJson) blockingFailures.push(invalidJson);
      } else if (extension === ".png" && !isPng(path)) {
        blockingFailures.push(
          `invalid PNG screenshot artifact for ${track}: ${path}`,
        );
      } else if (
        ![".json", ".log", ".txt", ".png", ".wav"].includes(extension) ||
        (extension === ".wav" && !allowedWav)
      ) {
        blockingFailures.push(
          `unsupported evidence artifact for ${track}: ${path}`,
        );
      } else if (!allowedWav) {
        const disguised = disguisedArtifact(path);
        if (disguised) blockingFailures.push(disguised);
      }
    }
    const reportRecord = bytesRecord(reportPath, "reports", track);
    const trace = reportTrace(track, reportPath, report, artifactFiles);
    const physical = physicalEvidence(track, artifactFiles);
    const embeddedLog = reportLog(track, reportPath, report);
    const logs = [...physical.logs, ...(embeddedLog ? [embeddedLog] : [])];
    const physicalLogs = physical.logs;
    files.push(
      reportRecord,
      ...physical.supporting,
      ...physicalLogs,
      ...physical.screenshots,
    );
    if (trace) sections.push(trace);
    if (embeddedLog) sections.push(embeddedLog);
    const evidence = {
      key: track,
      businessStatus,
      evidencePolicy,
      report: reportRecord.path,
      machineRuntimeTrace: trace?.path ?? null,
      logs: logs.map((file) => file.path),
      screenshots: physical.selectedScreenshots.map((file) => file.path),
      primaryReason: primaryFailureReason(report),
      diagnostics: [
        ...physical.supporting.map((file) => file.path),
        ...logs.map((file) => file.path),
      ],
    };
    trackEvidence.push(evidence);
    if (track === "aiVirtualTryOn" && businessStatus === "passed") {
      const screenshotFailure = validateAiReportScreenshots(
        report,
        artifactRoot,
        evidence,
        files,
      );
      if (screenshotFailure) blockingFailures.push(screenshotFailure);
    }
    if (businessStatus === "passed") {
      if (evidencePolicy.trace && !trace)
        failures.push(`actual Machine Runtime Trace is absent for ${track}`);
      if (evidencePolicy.logs && logs.length === 0)
        failures.push(`actual log evidence is absent for ${track}`);
      if (track === "aiVirtualTryOn" && physical.selectedScreenshots.length < 4)
        blockingFailures.push(
          "AI virtual try-on requires acquisition and result PNG evidence for both attempts",
        );
      else if (physical.selectedScreenshots.length === 0)
        failures.push(
          `optional PNG screenshot evidence is absent for ${track}`,
        );
    } else {
      if (evidencePolicy.primaryReason && !evidence.primaryReason)
        failures.push(`primary failure reason is absent for ${track}`);
      if (evidencePolicy.diagnostic && evidence.diagnostics.length === 0)
        failures.push(`diagnostic evidence is absent for ${track}`);
    }
  }
  for (const file of [...files, ...sections]) {
    if (file.byteLength > perFileLimit(file)) {
      blockingFailures.push(
        `${file.kind} evidence exceeds its limit: ${file.path}`,
      );
    }
  }
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (totalBytes > EVIDENCE_LIMITS.totalBytes)
    blockingFailures.push("evidence artifacts exceed the total size limit");
  return {
    schemaVersion: "vem-local-testbed-full-workflow-evidence-manifest/v2",
    // Business validators decide acceptance. Authority, format, and size
    // failures are blocking; genuinely optional absence stays a warning.
    ok: blockingFailures.length === 0,
    limits: EVIDENCE_LIMITS,
    requiredKinds: [...REQUIRED_KINDS],
    totals: {
      byteLength: totalBytes,
      tracks: trackEvidence.length,
      reports: files.filter((file) => file.kind === "reports").length,
      machineRuntimeTrace: sections.filter(
        (file) => file.kind === "machineRuntimeTrace",
      ).length,
      logs:
        files.filter((file) => file.kind === "logs").length +
        sections.filter((file) => file.kind === "logs").length,
      screenshots: files.filter((file) => file.kind === "screenshots").length,
    },
    tracks: trackEvidence,
    files,
    sections,
    warnings: failures,
    failures: blockingFailures,
  };
}

export function validateFullWorkflowEvidenceManifest(manifest) {
  const failures = [];
  if (
    manifest?.schemaVersion !==
    "vem-local-testbed-full-workflow-evidence-manifest/v2"
  )
    failures.push("evidence manifest schema is invalid");
  if (manifest?.ok !== true) failures.push("evidence manifest is not passing");
  if (
    JSON.stringify(manifest?.limits) !== JSON.stringify(EVIDENCE_LIMITS) ||
    JSON.stringify(manifest?.requiredKinds) !== JSON.stringify(REQUIRED_KINDS)
  )
    failures.push("evidence manifest limits or required kinds drifted");
  if (!Array.isArray(manifest?.tracks) || manifest.tracks.length === 0) {
    failures.push("per-track evidence manifest is missing");
  } else {
    for (const track of manifest.tracks) {
      const failedBusinessTrack = track?.businessStatus === "failed";
      if (
        track?.businessStatus != null &&
        !["passed", "failed"].includes(track.businessStatus)
      ) {
        failures.push(
          `per-track business status is invalid for ${track?.key ?? "unknown"}`,
        );
        continue;
      }
      if (
        typeof track?.key !== "string" ||
        (failedBusinessTrack
          ? typeof track?.primaryReason !== "string" ||
            track.primaryReason.trim() === "" ||
            !Array.isArray(track?.diagnostics) ||
            track.diagnostics.length === 0
          : (typeof track?.machineRuntimeTrace !== "string" &&
              track?.machineRuntimeTrace !== null) ||
            !Array.isArray(track?.logs) ||
            !Array.isArray(track?.screenshots))
      ) {
        failures.push(
          `per-track evidence is incomplete for ${track?.key ?? "unknown"}`,
        );
        continue;
      }
      const records = [...(manifest.files ?? []), ...(manifest.sections ?? [])];
      const owns = (path, kind) =>
        records.some(
          (record) =>
            record?.track === track.key &&
            record?.kind === kind &&
            record?.path === path,
        );
      if (!owns(track.report, "reports"))
        failures.push(`report evidence is not owned by ${track.key}`);
      if (!failedBusinessTrack) {
        if (
          track.machineRuntimeTrace != null &&
          !owns(track.machineRuntimeTrace, "machineRuntimeTrace")
        )
          failures.push(`Machine Runtime Trace is not owned by ${track.key}`);
        if (track.logs.some((path) => !owns(path, "logs")))
          failures.push(`log evidence is not owned by ${track.key}`);
        if (track.screenshots.some((path) => !owns(path, "screenshots")))
          failures.push(`screenshot evidence is not owned by ${track.key}`);
        if (track.screenshots.length > (track.key === "aiVirtualTryOn" ? 4 : 3))
          failures.push(`too many selected screenshots for ${track.key}`);
      } else if (
        track.diagnostics.some(
          (path) =>
            !records.some(
              (record) => record?.track === track.key && record?.path === path,
            ),
        )
      ) {
        failures.push(`diagnostic evidence is not owned by ${track.key}`);
      }
    }
  }
  if (!Array.isArray(manifest?.files)) {
    failures.push("evidence manifest files are missing");
  } else if (
    manifest.files.some(
      (file) =>
        typeof file?.track !== "string" ||
        ![
          "reports",
          "supportingEvidence",
          "screenshots",
          ...REQUIRED_KINDS,
        ].includes(file?.kind) ||
        typeof file?.path !== "string" ||
        !Number.isInteger(file?.byteLength) ||
        file.byteLength < 0 ||
        !/^[a-f0-9]{64}$/.test(file?.sha256 ?? ""),
    )
  ) {
    failures.push("evidence manifest includes an invalid file record");
  }
  if (
    !Array.isArray(manifest?.sections) ||
    manifest.sections.some(
      (section) =>
        typeof section?.track !== "string" ||
        !["machineRuntimeTrace", "logs"].includes(section?.kind) ||
        typeof section?.path !== "string" ||
        !section.path.includes("#") ||
        !Number.isInteger(section?.byteLength) ||
        section.byteLength < 0 ||
        !/^[a-f0-9]{64}$/.test(section?.sha256 ?? ""),
    )
  )
    failures.push("evidence manifest includes an invalid embedded section");
  const records = [...(manifest?.files ?? []), ...(manifest?.sections ?? [])];
  for (const record of records) {
    if (
      Number.isInteger(record?.byteLength) &&
      record.byteLength > perFileLimit(record)
    )
      failures.push(
        `${record.kind} evidence exceeds its limit: ${record.path}`,
      );
  }
  const totalBytes = (manifest?.files ?? []).reduce(
    (total, file) =>
      total + (Number.isInteger(file?.byteLength) ? file.byteLength : 0),
    0,
  );
  if (totalBytes !== manifest?.totals?.byteLength)
    failures.push("evidence manifest total byte count is inconsistent");
  if (totalBytes > EVIDENCE_LIMITS.totalBytes)
    failures.push("evidence artifacts exceed the total size limit");
  for (const failure of manifest?.failures ?? [])
    failures.push(`evidence manifest failure: ${failure}`);
  return failures;
}

export function validateFullWorkflowEvidenceOwnedFiles(manifest) {
  const failures = [];
  for (const file of manifest?.files ?? []) {
    try {
      requireRegularUnlinkedFile(file.path, "owned evidence artifact");
      const content = readFileSync(file.path);
      const digest = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== file.byteLength || digest !== file.sha256)
        failures.push(`owned evidence digest or size changed: ${file.path}`);
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error.message
          : `owned evidence artifact is invalid: ${file?.path ?? "unknown"}`,
      );
    }
  }
  return failures;
}

export function validateFullWorkflowEvidenceForUpload(manifest) {
  return [
    ...validateFullWorkflowEvidenceManifest(manifest),
    ...validateFullWorkflowEvidenceOwnedFiles(manifest),
  ];
}

function readJsonRegular(path, label) {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path))
    throw new Error(`${label} path must be absolute`);
  const resolvedPath = resolve(path);
  requireRegularUnlinkedFile(resolvedPath, label);
  const raw = readFileSync(resolvedPath);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return { path: resolvedPath, raw, value };
}

export function validateFullWorkflowEvidenceUploadFiles(
  manifestPath,
  summaryPath,
) {
  const manifestFile = readJsonRegular(manifestPath, "evidence manifest");
  const summaryFile = readJsonRegular(summaryPath, "workflow summary");
  const summary = summaryFile.value;
  if (
    summary?.ok !== true ||
    summary?.businessOutcome?.ok !== true ||
    summary?.evidenceInventory?.ok !== true
  )
    throw new Error("workflow evidence is diagnostic-only and not uploadable");
  const digest = createHash("sha256").update(manifestFile.raw).digest("hex");
  if (
    summary?.evidenceInventory?.reportPath !== manifestFile.path ||
    summary?.evidenceInventory?.manifestFile?.byteLength !==
      manifestFile.raw.byteLength ||
    summary?.evidenceInventory?.manifestFile?.sha256 !== digest
  )
    throw new Error(
      "workflow evidence manifest changed after aggregate decision",
    );
  const failures = validateFullWorkflowEvidenceForUpload(manifestFile.value);
  if (failures.length > 0)
    throw new Error(
      `evidence manifest is not uploadable: ${failures.join("; ")}`,
    );
  return { manifestFile, summaryFile };
}

function validateOwnedManifestCli(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--validate-upload" ||
    typeof args[1] !== "string" ||
    typeof args[2] !== "string"
  )
    throw new Error(
      "usage: --validate-upload <absolute-manifest-path> <absolute-summary-path>",
    );
  validateFullWorkflowEvidenceUploadFiles(args[1], args[2]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    validateOwnedManifestCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
