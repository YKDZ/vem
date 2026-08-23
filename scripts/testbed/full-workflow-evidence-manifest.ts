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

import { redactSensitiveEvidenceText } from "./failure-evidence-redaction.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

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
    trace: true,
    logs: true,
    screenshot: true,
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

function pathStaysWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const declaredRoot = resolve(path);
  const rootStat = lstatSync(declaredRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error(
      `non-regular or linked evidence artifact root: ${declaredRoot}`,
    );
  const canonicalRoot = realpathSync(declaredRoot);
  const visit = (candidate: string): string[] => {
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

function requireRegularUnlinkedFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${label} must be a regular non-linked file: ${path}`);
}

function bytesRecord(path: string, kind: string, track: string): JsonRecord {
  const content = readFileSync(path);
  return {
    path,
    track,
    kind,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function virtualRecord(
  reportPath: string,
  jsonPath: string,
  kind: string,
  track: string,
  value: unknown,
): JsonRecord {
  const content = Buffer.from(JSON.stringify(value));
  return {
    path: `${reportPath}#${jsonPath}`,
    track,
    kind,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function meaningfulLog(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !recordValue(value).error &&
    Object.keys(recordValue(value)).length > 0
  );
}

function primaryFailureReason(
  report: JsonRecord | null | undefined,
  result: JsonRecord | null = null,
): string | null {
  const reportRecord = recordValue(report);
  const reportCandidates = [
    recordValue(reportRecord.errors).primary,
    recordValue(reportRecord.failure).primaryReason,
    recordValue(reportRecord.failure).message,
    reportRecord.error,
  ];
  for (const value of reportCandidates) {
    if (typeof value === "string" && value.trim() !== "")
      return redactSensitiveEvidenceText(value.trim());
    if (value && typeof value === "object") {
      const name =
        typeof recordValue(value).name === "string"
          ? redactSensitiveEvidenceText(String(recordValue(value).name).trim())
          : "";
      const message =
        typeof recordValue(value).message === "string"
          ? redactSensitiveEvidenceText(
              String(recordValue(value).message).trim(),
            )
          : "";
      if (name && message) return `${name}: ${message}`;
      if (message || name) return message || name;
    }
  }
  for (const value of [result?.error, recordValue(result?.validator).reason]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function isPng(path: string): boolean {
  const signature = readFileSync(path).subarray(0, 8);
  return signature.equals(PNG_SIGNATURE);
}

function forbiddenMagic(content: Buffer): string | null {
  for (const entry of FORBIDDEN_MAGIC) {
    const [label, signature] = entry as [string, Buffer];
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

function disguisedArtifact(path: string): string | null {
  if (extname(path).toLowerCase() === ".png") return null;
  const magic = forbiddenMagic(readFileSync(path));
  return magic
    ? `disguised executable or archive/media (${magic}) in evidence artifact: ${path}`
    : null;
}

function reportTrace(
  track: string,
  reportPath: string,
  report: JsonRecord | null,
  artifactFiles: string[],
): JsonRecord | null {
  const reportRecord = recordValue(report);
  const ipcRecovery = recordValue(reportRecord.ipcRecovery);
  const ipcProvenance = recordValue(ipcRecovery.provenance);
  const ipcUi = recordValue(ipcProvenance.ui);
  const direct: [string, unknown] | undefined = {
    sale: ["runtimeTrace", reportRecord.runtimeTrace],
    scannerPayment: ["runtimeTrace", reportRecord.runtimeTrace],
    visionExperience: ["runtimeTrace", reportRecord.runtimeTrace],
    presenceAndAudio: [
      "presenceAndAudio.runtimeTrace",
      recordValue(reportRecord.presenceAndAudio).runtimeTrace,
    ],
    ipcRecovery: [
      "ipcRecovery.provenance.ui",
      [
        ...arrayValue(recordValue(ipcUi.before).runtimeTrace),
        ...arrayValue(recordValue(ipcUi.after).runtimeTrace),
      ],
    ],
    fulfillmentRecovery: [
      "evidence.ui.trace",
      recordValue(recordValue(reportRecord.evidence).ui).trace,
    ],
  }[track] as [string, unknown] | undefined;
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
        const evidence = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
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
  const failureDiagnosticsPath = artifactFiles.find(
    (candidate) => basename(candidate) === "failure-diagnostics.json",
  );
  if (failureDiagnosticsPath) {
    try {
      const diagnostics = JSON.parse(
        readFileSync(failureDiagnosticsPath, "utf8"),
      ) as JsonRecord;
      const trace = Array.isArray(diagnostics?.machineRuntimeTrace)
        ? diagnostics.machineRuntimeTrace
        : recordValue(diagnostics.machineRuntimeTraceSnapshot).entries;
      if (nonEmptyArray(trace)) {
        return virtualRecord(
          failureDiagnosticsPath,
          "machineRuntimeTrace",
          "machineRuntimeTrace",
          track,
          trace,
        );
      }
    } catch {}
  }
  return null;
}

function reportLog(
  track: string,
  reportPath: string,
  report: JsonRecord | null,
): JsonRecord | null {
  const reportRecord = recordValue(report);
  const evidence = recordValue(reportRecord.evidence);
  const source = {
    scannerPayment: [
      "serial.rawFrames",
      recordValue(reportRecord.serial).rawFrames,
    ],
    ipcRecovery: [
      "serial.rawFrames",
      recordValue(reportRecord.serial).rawFrames,
    ],
    fulfillmentRecovery: ["evidence.platformLog", evidence.platformLog],
  }[track] as [string, unknown] | undefined;
  if (!source || !meaningfulLog(source[1])) return null;
  return virtualRecord(reportPath, source[0], "logs", track, source[1]);
}

function physicalEvidence(
  track: string,
  artifactFiles: string[],
): {
  supporting: JsonRecord[];
  logs: JsonRecord[];
  screenshots: JsonRecord[];
  selectedScreenshots: JsonRecord[];
} {
  const supporting = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".json")
    .map((path: string) => bytesRecord(path, "supportingEvidence", track));
  const logs = artifactFiles
    .filter((path) => {
      const extension = extname(path).toLowerCase();
      return (
        [".log", ".txt"].includes(extension) ||
        (track === "presenceAndAudio" && extension === ".wav")
      );
    })
    .map((path: string) => bytesRecord(path, "logs", track))
    .filter((record: JsonRecord) => Number(record.byteLength) > 0);
  const screenshotCandidates = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".png" && isPng(path))
    .map((path: string) => bytesRecord(path, "screenshots", track));
  const screenshotScore = (record: JsonRecord): number => {
    const name = basename(String(record.path)).toLowerCase();
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
        String(right.path).localeCompare(String(left.path)),
    )
    .slice(0, 3);
  return {
    supporting,
    logs,
    screenshots: screenshotCandidates,
    selectedScreenshots,
  };
}

function perFileLimit(file: JsonRecord): number {
  if (file.kind === "reports") return EVIDENCE_LIMITS.reportPerFileBytes;
  if (file.kind === "supportingEvidence")
    return EVIDENCE_LIMITS.reportPerFileBytes;
  if (file.kind === "machineRuntimeTrace")
    return EVIDENCE_LIMITS.tracePerTrackBytes;
  if (file.kind === "logs") return EVIDENCE_LIMITS.logPerFileBytes;
  return EVIDENCE_LIMITS.screenshotPerFileBytes;
}

export function buildFullWorkflowEvidenceManifest({
  tracks = [],
}: {
  tracks?: JsonRecord[];
} = {}): JsonRecord {
  const failures: string[] = [];
  const blockingFailures: string[] = [];
  const files: JsonRecord[] = [];
  const sections: JsonRecord[] = [];
  const trackEvidence: JsonRecord[] = [];
  for (const input of tracks) {
    const inputRecord = recordValue(input);
    const track = inputRecord?.key;
    const reportPath = resolve(String(inputRecord?.reportPath ?? ""));
    const artifactRoot = inputRecord?.artifactRoot
      ? resolve(String(inputRecord?.artifactRoot))
      : null;
    const result = recordValue(inputRecord.result);
    const evidenceTrust = recordValue(result.evidenceTrust);
    const reportTrusted = evidenceTrust?.report !== false;
    const artifactRootTrusted = evidenceTrust?.artifactRoot !== false;
    if (!track) {
      blockingFailures.push("required evidence track identity is absent");
      continue;
    }
    let report: JsonRecord | null = null;
    let reportRecord: JsonRecord | null = null;
    if (!reportTrusted) {
      blockingFailures.push(`report artifact is untrusted for ${track}`);
    } else if (!existsSync(reportPath)) {
      blockingFailures.push(`required report artifact is absent for ${track}`);
    } else
      try {
        requireRegularUnlinkedFile(reportPath, "required report artifact");
        report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonRecord;
        reportRecord = bytesRecord(reportPath, "reports", String(track));
      } catch (error) {
        blockingFailures.push(
          error instanceof Error
            ? `required report artifact is invalid for ${track}: ${error.message}`
            : `required report artifact is invalid for ${track}`,
        );
      }
    const businessStatus =
      result?.businessStatus === "passed" ? "passed" : "failed";
    const evidencePolicy = (recordValue(inputRecord.evidence)[businessStatus] ??
      DEFAULT_EVIDENCE_POLICY[businessStatus]) as JsonRecord;
    let artifactFiles: string[] = [];
    if (!artifactRootTrusted) {
      blockingFailures.push(`artifact root is untrusted for ${track}`);
    } else if (!artifactRoot || !existsSync(artifactRoot)) {
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
    const validatedArtifactFiles: string[] = [];
    for (const path of artifactFiles) {
      try {
        const extension = extname(path).toLowerCase();
        const allowedWav = track === "presenceAndAudio" && extension === ".wav";
        if (FORBIDDEN_EXTENSIONS.has(extension) && !allowedWav) {
          blockingFailures.push(
            `forbidden evidence artifact for ${track}: ${path}`,
          );
          continue;
        }
        if (extension === ".png" && !isPng(path)) {
          blockingFailures.push(
            `invalid PNG screenshot artifact for ${track}: ${path}`,
          );
          continue;
        }
        if (
          ![".json", ".log", ".txt", ".png", ".wav"].includes(extension) ||
          (extension === ".wav" && !allowedWav)
        ) {
          blockingFailures.push(
            `unsupported evidence artifact for ${track}: ${path}`,
          );
          continue;
        }
        if (!allowedWav) {
          const disguised = disguisedArtifact(path);
          if (disguised) {
            blockingFailures.push(disguised);
            continue;
          }
        }
        validatedArtifactFiles.push(path);
      } catch (error) {
        blockingFailures.push(
          `evidence artifact became unreadable for ${track}: ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    artifactFiles = validatedArtifactFiles;
    let trace: JsonRecord | null = null;
    let physical: {
      supporting: JsonRecord[];
      logs: JsonRecord[];
      screenshots: JsonRecord[];
      selectedScreenshots: JsonRecord[];
    } = {
      supporting: [],
      logs: [],
      screenshots: [],
      selectedScreenshots: [],
    };
    try {
      trace = reportTrace(String(track), reportPath, report, artifactFiles);
      physical = physicalEvidence(String(track), artifactFiles);
    } catch (error) {
      blockingFailures.push(
        `evidence artifact changed during capture for ${track}: ${error instanceof Error ? error.message : String(error)}`,
      );
      trace = null;
      physical = {
        supporting: [],
        logs: [],
        screenshots: [],
        selectedScreenshots: [],
      } as {
        supporting: JsonRecord[];
        logs: JsonRecord[];
        screenshots: JsonRecord[];
        selectedScreenshots: JsonRecord[];
      };
    }
    const embeddedLog = reportLog(String(track), reportPath, report);
    const logs: JsonRecord[] = [
      ...physical.logs,
      ...(embeddedLog ? [embeddedLog] : []),
    ];
    const physicalLogs = physical.logs;
    files.push(
      ...(reportRecord ? [reportRecord] : []),
      ...physical.supporting,
      ...(physicalLogs as JsonRecord[]),
      ...physical.screenshots,
    );
    if (trace) sections.push(trace);
    if (embeddedLog) sections.push(embeddedLog);
    const evidence = {
      key: track,
      businessStatus,
      evidencePolicy,
      report: reportRecord?.path ?? null,
      machineRuntimeTrace: trace?.path ?? null,
      logs: logs.map((file: JsonRecord) => file.path),
      screenshots: physical.selectedScreenshots.map(
        (file: JsonRecord) => file.path,
      ),
      primaryReason: primaryFailureReason(report, result),
      diagnostics: [
        ...physical.supporting.map((file: JsonRecord) => file.path),
        ...logs.map((file: JsonRecord) => file.path),
      ],
    };
    trackEvidence.push(evidence);
    if (businessStatus === "passed") {
      if (evidencePolicy.trace && !trace)
        failures.push(`actual Machine Runtime Trace is absent for ${track}`);
      if (evidencePolicy.logs && logs.length === 0)
        failures.push(`actual log evidence is absent for ${track}`);
      if (physical.selectedScreenshots.length === 0)
        failures.push(
          `optional PNG screenshot evidence is absent for ${track}`,
        );
    } else {
      if (evidencePolicy.primaryReason && !evidence.primaryReason)
        failures.push(`primary failure reason is absent for ${track}`);
      if (
        evidencePolicy.diagnostic &&
        (evidence.diagnostics as unknown[]).length === 0
      )
        failures.push(`diagnostic evidence is absent for ${track}`);
      if (evidencePolicy.trace && !trace)
        failures.push(`failed Machine Runtime Trace is absent for ${track}`);
      if (evidencePolicy.logs && logs.length === 0)
        failures.push(`failed log evidence is absent for ${track}`);
      if (
        evidencePolicy.screenshot &&
        physical.selectedScreenshots.length === 0
      )
        failures.push(`failure screenshot evidence is absent for ${track}`);
    }
  }
  for (const file of [...files, ...sections]) {
    if (Number(file.byteLength) > perFileLimit(file)) {
      blockingFailures.push(
        `${file.kind} evidence exceeds its limit: ${file.path}`,
      );
    }
  }
  const totalBytes = files.reduce(
    (total: number, file: JsonRecord) => total + Number(file.byteLength),
    0,
  );
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

export function validateFullWorkflowEvidenceManifest(
  manifest: JsonRecord,
): string[] {
  const manifestRecord = recordValue(manifest);
  const tracks = arrayValue(manifestRecord.tracks).map((entry: unknown) =>
    recordValue(entry),
  );
  const manifestFiles = arrayValue(manifestRecord.files).map((entry: unknown) =>
    recordValue(entry),
  );
  const manifestSections = arrayValue(manifestRecord.sections).map(
    (entry: unknown) => recordValue(entry),
  );
  const failures: string[] = [];
  if (
    manifestRecord?.schemaVersion !==
    "vem-local-testbed-full-workflow-evidence-manifest/v2"
  )
    failures.push("evidence manifest schema is invalid");
  if (manifestRecord?.ok !== true)
    failures.push("evidence manifest is not passing");
  if (
    JSON.stringify(manifestRecord?.limits) !==
      JSON.stringify(EVIDENCE_LIMITS) ||
    JSON.stringify(manifestRecord?.requiredKinds) !==
      JSON.stringify(REQUIRED_KINDS)
  )
    failures.push("evidence manifest limits or required kinds drifted");
  if (tracks.length === 0) {
    failures.push("per-track evidence manifest is missing");
  } else {
    for (const track of tracks) {
      const failedBusinessTrack = track?.businessStatus === "failed";
      if (
        track?.businessStatus != null &&
        !["passed", "failed"].includes(String(track.businessStatus))
      ) {
        failures.push(
          `per-track business status is invalid for ${String(track?.key ?? "unknown")}`,
        );
        continue;
      }
      if (
        typeof track?.key !== "string" ||
        (failedBusinessTrack
          ? typeof track?.primaryReason !== "string" ||
            String(track.primaryReason).trim() === "" ||
            !Array.isArray(track?.diagnostics)
          : (typeof track?.machineRuntimeTrace !== "string" &&
              track?.machineRuntimeTrace !== null) ||
            !Array.isArray(track?.logs) ||
            !Array.isArray(track?.screenshots))
      ) {
        failures.push(
          `per-track evidence is incomplete for ${String(track?.key ?? "unknown")}`,
        );
        continue;
      }
      const records = [...manifestFiles, ...manifestSections];
      const owns = (path: unknown, kind: unknown) =>
        records.some(
          (record) =>
            record?.track === track.key &&
            record?.kind === kind &&
            record?.path === path,
        );
      if (track.report !== null && !owns(track.report, "reports"))
        failures.push(`report evidence is not owned by ${track.key}`);
      if (!failedBusinessTrack && track.report === null)
        failures.push(`passing report evidence is absent for ${track.key}`);
      if (!failedBusinessTrack) {
        if (
          track.machineRuntimeTrace != null &&
          !owns(track.machineRuntimeTrace, "machineRuntimeTrace")
        )
          failures.push(`Machine Runtime Trace is not owned by ${track.key}`);
        if (arrayValue(track.logs).some((path: unknown) => !owns(path, "logs")))
          failures.push(`log evidence is not owned by ${track.key}`);
        if (
          arrayValue(track.screenshots).some(
            (path: unknown) => !owns(path, "screenshots"),
          )
        )
          failures.push(`screenshot evidence is not owned by ${track.key}`);
        if (arrayValue(track.screenshots).length > 3)
          failures.push(`too many selected screenshots for ${track.key}`);
      } else if (
        arrayValue(track.diagnostics).some(
          (path: unknown) =>
            !records.some(
              (record) => record?.track === track.key && record?.path === path,
            ),
        )
      ) {
        failures.push(`diagnostic evidence is not owned by ${track.key}`);
      }
    }
  }
  if (!Array.isArray(manifestRecord.files)) {
    failures.push("evidence manifest files are missing");
  } else if (
    manifestFiles.some(
      (file: JsonRecord) =>
        typeof file?.track !== "string" ||
        ![
          "reports",
          "supportingEvidence",
          "screenshots",
          ...REQUIRED_KINDS,
        ].includes(String(file?.kind)) ||
        typeof file?.path !== "string" ||
        !Number.isInteger(file?.byteLength) ||
        Number(file.byteLength) < 0 ||
        !/^[a-f0-9]{64}$/.test(String(file?.sha256 ?? "")),
    )
  ) {
    failures.push("evidence manifest includes an invalid file record");
  }
  if (
    !Array.isArray(manifestRecord.sections) ||
    manifestSections.some(
      (section: JsonRecord) =>
        typeof section?.track !== "string" ||
        !["machineRuntimeTrace", "logs"].includes(String(section?.kind)) ||
        typeof section?.path !== "string" ||
        !section.path.includes("#") ||
        !Number.isInteger(section?.byteLength) ||
        Number(section.byteLength) < 0 ||
        !/^[a-f0-9]{64}$/.test(String(section?.sha256 ?? "")),
    )
  )
    failures.push("evidence manifest includes an invalid embedded section");
  const records = [...manifestFiles, ...manifestSections];
  for (const record of records) {
    if (
      Number.isInteger(record?.byteLength) &&
      Number(record.byteLength) > perFileLimit(record)
    )
      failures.push(
        `${record.kind} evidence exceeds its limit: ${record.path}`,
      );
  }
  const totalBytes = manifestFiles.reduce(
    (total: number, file: JsonRecord) =>
      total +
      (Number.isInteger(file?.byteLength) ? Number(file.byteLength) : 0),
    0,
  );
  if (totalBytes !== Number(recordValue(manifestRecord.totals).byteLength))
    failures.push("evidence manifest total byte count is inconsistent");
  if (totalBytes > EVIDENCE_LIMITS.totalBytes)
    failures.push("evidence artifacts exceed the total size limit");
  for (const failure of arrayValue(manifestRecord.failures))
    failures.push(`evidence manifest failure: ${failure}`);
  return failures;
}

export function validateFullWorkflowEvidenceOwnedFiles(
  manifest: JsonRecord,
): string[] {
  const failures: string[] = [];
  for (const file of arrayValue(recordValue(manifest).files).map(
    (entry: unknown) => recordValue(entry),
  )) {
    try {
      requireRegularUnlinkedFile(String(file.path), "owned evidence artifact");
      const content = readFileSync(String(file.path));
      const digest = createHash("sha256").update(content).digest("hex");
      if (
        content.byteLength !== Number(file.byteLength) ||
        digest !== file.sha256
      )
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

export function validateFullWorkflowEvidenceForUpload(
  manifest: JsonRecord,
): string[] {
  return [
    ...validateFullWorkflowEvidenceManifest(manifest),
    ...validateFullWorkflowEvidenceOwnedFiles(manifest),
  ];
}

function readJsonRegular(
  path: unknown,
  label: string,
): { path: string; raw: Buffer; value: JsonRecord } {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path))
    throw new Error(`${label} path must be absolute`);
  const resolvedPath = resolve(path);
  requireRegularUnlinkedFile(resolvedPath, label);
  const raw = readFileSync(resolvedPath);
  let value: JsonRecord;
  try {
    value = JSON.parse(raw.toString("utf8")) as JsonRecord;
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return { path: resolvedPath, raw, value };
}

export function validateFullWorkflowEvidenceUploadFiles(
  manifestPath: string,
  summaryPath: string,
): JsonRecord {
  const manifestFile = readJsonRegular(manifestPath, "evidence manifest");
  const summaryFile = readJsonRegular(summaryPath, "workflow summary");
  const summary = summaryFile.value;
  const evidenceInventory = recordValue(summary.evidenceInventory);
  const manifestFileValue = recordValue(evidenceInventory.manifestFile);
  if (
    summary?.schemaVersion !== "vem-local-testbed-full-workflow/v4" ||
    !Array.isArray(recordValue(summary.businessOutcome).failures) ||
    evidenceInventory?.ok !== true
  )
    throw new Error("workflow evidence summary is not uploadable");
  const digest = createHash("sha256").update(manifestFile.raw).digest("hex");
  if (
    evidenceInventory?.reportPath !== manifestFile.path ||
    manifestFileValue?.byteLength !== manifestFile.raw.byteLength ||
    manifestFileValue?.sha256 !== digest
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

function validateOwnedManifestCli(args: string[]): void {
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
