import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

export const EVIDENCE_LIMITS = Object.freeze({
  tracePerFileBytes: 512 * 1024,
  logPerFileBytes: 256 * 1024,
  screenshotPerFileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
});

const ALLOWED_EXTENSIONS = new Set([".json", ".log", ".txt", ".png"]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".avi",
  ".bin",
  ".dll",
  ".exe",
  ".gif",
  ".iso",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".qcow2",
  ".wav",
  ".webm",
  ".zip",
]);
const REQUIRED_KINDS = Object.freeze(["traces", "logs", "screenshots"]);

function filesUnder(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(resolve(path, entry.name)),
  );
}

function classify(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "screenshots";
  if (extension === ".log" || extension === ".txt") return "logs";
  if (extension === ".json") return "traces";
  return null;
}

function perFileLimit(kind) {
  if (kind === "traces") return EVIDENCE_LIMITS.tracePerFileBytes;
  if (kind === "logs") return EVIDENCE_LIMITS.logPerFileBytes;
  return EVIDENCE_LIMITS.screenshotPerFileBytes;
}

function fileRecord(path, kind) {
  const content = readFileSync(path);
  return {
    path,
    kind,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function buildFullWorkflowEvidenceManifest({
  reportPaths = [],
  artifactRoots = [],
} = {}) {
  const failures = [];
  const files = [];
  const seen = new Set();
  for (const reportPath of reportPaths) {
    if (!existsSync(reportPath)) {
      failures.push(`required report artifact is absent: ${reportPath}`);
      continue;
    }
    const path = resolve(reportPath);
    seen.add(path);
    files.push(fileRecord(path, "traces"));
  }
  for (const root of artifactRoots) {
    if (!existsSync(root)) {
      failures.push(`required artifact root is absent: ${root}`);
      continue;
    }
    for (const candidate of filesUnder(root)) {
      const path = resolve(candidate);
      if (seen.has(path)) continue;
      seen.add(path);
      const extension = extname(path).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(extension)) {
        failures.push(`forbidden evidence artifact: ${path}`);
        continue;
      }
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        failures.push(`unsupported evidence artifact: ${path}`);
        continue;
      }
      files.push(fileRecord(path, classify(path)));
    }
  }
  const totals = {
    byteLength: files.reduce((total, file) => total + file.byteLength, 0),
    traces: files.filter((file) => file.kind === "traces").length,
    logs: files.filter((file) => file.kind === "logs").length,
    screenshots: files.filter((file) => file.kind === "screenshots").length,
  };
  for (const file of files) {
    if (file.byteLength > perFileLimit(file.kind)) {
      failures.push(
        `${file.kind} artifact exceeds its per-file limit: ${file.path}`,
      );
    }
  }
  if (totals.byteLength > EVIDENCE_LIMITS.totalBytes) {
    failures.push("evidence artifacts exceed the total size limit");
  }
  for (const kind of REQUIRED_KINDS) {
    if (totals[kind] === 0)
      failures.push(`required ${kind} artifact is absent`);
  }
  return {
    schemaVersion: "vem-local-testbed-full-workflow-evidence-manifest/v1",
    ok: failures.length === 0,
    limits: EVIDENCE_LIMITS,
    requiredKinds: [...REQUIRED_KINDS],
    totals,
    files,
    failures,
  };
}

export function validateFullWorkflowEvidenceManifest(manifest) {
  const failures = [];
  if (
    manifest?.schemaVersion !==
    "vem-local-testbed-full-workflow-evidence-manifest/v1"
  ) {
    failures.push("evidence manifest schema is invalid");
  }
  if (manifest?.ok !== true) failures.push("evidence manifest is not passing");
  if (
    JSON.stringify(manifest?.limits) !== JSON.stringify(EVIDENCE_LIMITS) ||
    JSON.stringify(manifest?.requiredKinds) !== JSON.stringify(REQUIRED_KINDS)
  ) {
    failures.push("evidence manifest limits or required kinds drifted");
  }
  if (!Array.isArray(manifest?.files)) {
    failures.push("evidence manifest files are missing");
  } else {
    for (const file of manifest.files) {
      if (
        !REQUIRED_KINDS.includes(file?.kind) ||
        typeof file?.path !== "string" ||
        !Number.isInteger(file?.byteLength) ||
        file.byteLength < 0 ||
        !/^[a-f0-9]{64}$/.test(file?.sha256 ?? "")
      ) {
        failures.push("evidence manifest includes an invalid file record");
        break;
      }
    }
  }
  for (const failure of manifest?.failures ?? []) {
    failures.push(`evidence manifest failure: ${failure}`);
  }
  return failures;
}
