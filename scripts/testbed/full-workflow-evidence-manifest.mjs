import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

export const EVIDENCE_LIMITS = Object.freeze({
  reportPerFileBytes: 512 * 1024,
  tracePerTrackBytes: 512 * 1024,
  logPerFileBytes: 256 * 1024,
  screenshotPerFileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
});

const REQUIRED_KINDS = Object.freeze([
  "machineRuntimeTrace",
  "logs",
  "screenshots",
]);
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

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [resolve(path)];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(resolve(path, entry.name)),
  );
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

function isPng(path) {
  const signature = readFileSync(path).subarray(0, 8);
  return signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function reportTrace(track, reportPath, report, artifactFiles) {
  const direct = {
    fast: ["runtimeTrace", report?.runtimeTrace],
    scanner: ["runtimeTrace", report?.runtimeTrace],
    visionTryOn: ["runtimeTrace", report?.runtimeTrace],
    ipcRecovery: [
      "ipcRecovery.provenance.ui",
      [
        ...(report?.ipcRecovery?.provenance?.ui?.before?.runtimeTrace ?? []),
        ...(report?.ipcRecovery?.provenance?.ui?.after?.runtimeTrace ?? []),
      ],
    ],
    fulfillmentFailure: ["evidence.ui.trace", report?.evidence?.ui?.trace],
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
  if (track === "delayedPickup") {
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
    scanner: ["serial.rawFrames", report?.serial?.rawFrames],
    ipcRecovery: ["serial.rawFrames", report?.serial?.rawFrames],
    fulfillmentFailure: ["evidence.platformLog", report?.evidence?.platformLog],
  }[track];
  if (!source || !meaningfulLog(source[1])) return null;
  return virtualRecord(reportPath, source[0], "logs", track, source[1]);
}

function physicalEvidence(track, artifactFiles) {
  const supporting = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".json")
    .map((path) => bytesRecord(path, "supportingEvidence", track));
  const logs = artifactFiles
    .filter((path) => [".log", ".txt"].includes(extname(path).toLowerCase()))
    .map((path) => bytesRecord(path, "logs", track))
    .filter((record) => record.byteLength > 0);
  const screenshots = artifactFiles
    .filter((path) => extname(path).toLowerCase() === ".png" && isPng(path))
    .map((path) => bytesRecord(path, "screenshots", track));
  return { supporting, logs, screenshots };
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
  const files = [];
  const sections = [];
  const trackEvidence = [];
  for (const input of tracks) {
    const track = input?.key;
    const reportPath = resolve(input?.reportPath ?? "");
    const artifactRoot = resolve(input?.artifactRoot ?? "");
    if (!track || !existsSync(reportPath)) {
      failures.push(
        `required report artifact is absent for ${track ?? "unknown"}`,
      );
      continue;
    }
    if (!existsSync(artifactRoot)) {
      failures.push(`required artifact root is absent for ${track}`);
      continue;
    }
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      failures.push(`required report artifact is invalid for ${track}`);
      continue;
    }
    const artifactFiles = filesUnder(artifactRoot);
    for (const path of artifactFiles) {
      const extension = extname(path).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(extension)) {
        failures.push(`forbidden evidence artifact for ${track}: ${path}`);
      } else if (extension === ".png" && !isPng(path)) {
        failures.push(`invalid PNG screenshot artifact for ${track}: ${path}`);
      } else if (![".json", ".log", ".txt", ".png"].includes(extension)) {
        failures.push(`unsupported evidence artifact for ${track}: ${path}`);
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
      report: reportRecord.path,
      machineRuntimeTrace: trace?.path ?? null,
      logs: logs.map((file) => file.path),
      screenshots: physical.screenshots.map((file) => file.path),
    };
    trackEvidence.push(evidence);
    if (!trace)
      failures.push(`actual Machine Runtime Trace is absent for ${track}`);
    if (logs.length === 0)
      failures.push(`actual log evidence is absent for ${track}`);
    if (physical.screenshots.length === 0)
      failures.push(`actual PNG screenshot evidence is absent for ${track}`);
  }
  for (const file of [...files, ...sections]) {
    if (file.byteLength > perFileLimit(file)) {
      failures.push(`${file.kind} evidence exceeds its limit: ${file.path}`);
    }
  }
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (totalBytes > EVIDENCE_LIMITS.totalBytes)
    failures.push("evidence artifacts exceed the total size limit");
  return {
    schemaVersion: "vem-local-testbed-full-workflow-evidence-manifest/v2",
    ok: failures.length === 0,
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
    failures,
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
      if (
        typeof track?.key !== "string" ||
        typeof track?.machineRuntimeTrace !== "string" ||
        !Array.isArray(track?.logs) ||
        track.logs.length === 0 ||
        !Array.isArray(track?.screenshots) ||
        track.screenshots.length === 0
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
      if (!owns(track.machineRuntimeTrace, "machineRuntimeTrace"))
        failures.push(`Machine Runtime Trace is not owned by ${track.key}`);
      if (track.logs.some((path) => !owns(path, "logs")))
        failures.push(`log evidence is not owned by ${track.key}`);
      if (track.screenshots.some((path) => !owns(path, "screenshots")))
        failures.push(`screenshot evidence is not owned by ${track.key}`);
    }
  }
  if (!Array.isArray(manifest?.files)) {
    failures.push("evidence manifest files are missing");
  } else if (
    manifest.files.some(
      (file) =>
        typeof file?.track !== "string" ||
        !["reports", "supportingEvidence", ...REQUIRED_KINDS].includes(
          file?.kind,
        ) ||
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
