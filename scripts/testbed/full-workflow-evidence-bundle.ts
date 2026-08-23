import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EVIDENCE_LIMITS,
  validateFullWorkflowEvidenceUploadFiles,
} from "./full-workflow-evidence-manifest.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function statIdentity(stat: {
  dev: unknown;
  ino: unknown;
  mode: unknown;
  nlink: unknown;
  size: unknown;
  mtimeNs: unknown;
  ctimeNs: unknown;
}): string {
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

function inodeIdentity(stat: {
  dev: unknown;
  ino: unknown;
  mode: unknown;
}): string {
  return [stat.dev, stat.ino, stat.mode].join(":");
}

function snapshotRegular(path: string, label: string): JsonRecord {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error(`${label} must be a regular non-linked file: ${path}`);
  const content = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (statIdentity(before) !== statIdentity(after))
    throw new Error(`${label} changed while it was read: ${path}`);
  return {
    path,
    identity: statIdentity(after),
    byteLength: content.byteLength,
    sha256: sha256(content),
  };
}

function assertSnapshot(
  snapshot: JsonRecord,
  expected: JsonRecord | null | undefined,
  label: string,
): void {
  const current = snapshotRegular(String(snapshot.path), label);
  if (
    current.identity !== snapshot.identity ||
    current.byteLength !== snapshot.byteLength ||
    current.sha256 !== snapshot.sha256 ||
    (expected &&
      (current.byteLength !== expected.byteLength ||
        current.sha256 !== expected.sha256))
  )
    throw new Error(
      `${label} identity, size, or digest changed: ${snapshot.path}`,
    );
}

function filesRecursively(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(root, relativePath);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink())
        throw new Error(
          `linked file in evidence bundle staging: ${relativePath}`,
        );
      if (stat.isFile()) return [relativePath];
      if (!stat.isDirectory())
        throw new Error(
          `special file in evidence bundle staging: ${relativePath}`,
        );
      return filesRecursively(root, relativePath);
    },
  );
}

function fsyncDirectory(path: string): void {
  // Windows directory publication is a single MoveFile operation. Node does
  // not provide a portable directory handle that FlushFileBuffers accepts.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishDirectoryNoReplace(source: string, destination: string): void {
  if (process.platform !== "win32")
    throw new Error(
      "exclusive evidence bundle directory publication is unsupported on this platform",
    );
  // MoveFile on Windows fails when the destination already exists. Node's
  // directory rename maps to that no-replace primitive on the guest platform.
  renameSync(source, destination);
}

function validateOptions(options: JsonRecord): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === "allowIncomplete") continue;
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error(`${name} must be an absolute path`);
  }
}

function readRegularJson(
  path: string,
  label: string,
): { path: string; raw: Buffer; value: JsonRecord } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${label} must be a regular non-linked file: ${path}`);
  const raw = readFileSync(path);
  return {
    path,
    raw,
    value: JSON.parse(raw.toString("utf8")) as JsonRecord,
  };
}

function incompleteFileLimit(kind: string): number | null {
  if (kind === "reports" || kind === "supportingEvidence")
    return EVIDENCE_LIMITS.reportPerFileBytes;
  if (kind === "screenshots") return EVIDENCE_LIMITS.screenshotPerFileBytes;
  if (kind === "logs") return EVIDENCE_LIMITS.logPerFileBytes;
  return null;
}

export function createFullWorkflowEvidenceBundle(
  options: JsonRecord,
  dependencies: JsonRecord = {},
): JsonRecord {
  validateOptions(options);
  const manifestPath = resolve(String(options.manifestPath));
  const summaryPath = resolve(String(options.summaryPath));
  const smokePath = resolve(String(options.smokePath));
  const bundleRoot = resolve(String(options.bundleRoot));
  const allowIncomplete = options.allowIncomplete === true;
  if (existsSync(bundleRoot))
    throw new Error(`evidence bundle destination exists: ${bundleRoot}`);

  const readFiles = allowIncomplete
    ? {
        manifestFile: readRegularJson(manifestPath, "evidence manifest"),
        summaryFile: readRegularJson(summaryPath, "workflow summary"),
      }
    : validateFullWorkflowEvidenceUploadFiles(manifestPath, summaryPath);
  const manifestFile = recordValue(readFiles.manifestFile);
  const summaryFile = recordValue(readFiles.summaryFile);
  const manifestFileRaw = manifestFile.raw as Buffer;
  const summaryFileRaw = summaryFile.raw as Buffer;
  if (allowIncomplete) {
    const binding = recordValue(
      recordValue(summaryFile.value).evidenceInventory,
    );
    const manifestFileValue = recordValue(binding.manifestFile);
    if (
      typeof binding?.reportPath !== "string" ||
      resolve(String(binding.reportPath)) !== manifestPath ||
      manifestFileValue?.byteLength !== manifestFileRaw.byteLength ||
      manifestFileValue?.sha256 !== sha256(manifestFileRaw)
    ) {
      throw new Error(
        "workflow summary does not bind the incomplete evidence manifest",
      );
    }
  }
  const manifest = recordValue(manifestFile.value);
  const declared = new Map<string, JsonRecord>();
  let declaredBytes = 0;
  for (const file of arrayValue(manifest.files).map((value: unknown) =>
    recordValue(value),
  )) {
    try {
      const path = resolve(String(file.path));
      const perFileLimit = incompleteFileLimit(String(file.kind));
      if (declared.has(path))
        throw new Error(`duplicate evidence source path: ${path}`);
      if (
        !isAbsolute(String(file.path)) ||
        perFileLimit === null ||
        !Number.isInteger(file.byteLength) ||
        Number(file.byteLength) < 0 ||
        Number(file.byteLength) > perFileLimit ||
        !/^[a-f0-9]{64}$/.test(String(file.sha256 ?? "")) ||
        declaredBytes + Number(file.byteLength) > EVIDENCE_LIMITS.totalBytes
      ) {
        throw new Error(`invalid bounded evidence record: ${file.path}`);
      }
      if (allowIncomplete) {
        const actual = snapshotRegular(path, "incomplete evidence source");
        if (
          actual.byteLength !== Number(file.byteLength) ||
          actual.sha256 !== file.sha256
        ) {
          continue;
        }
      }
      declared.set(path, file);
      declaredBytes += Number(file.byteLength);
    } catch (error) {
      if (!allowIncomplete) throw error;
    }
  }

  const metadata: Array<[string, string]> = [
    [summaryPath, "metadata/full-workflow-tracks.json"],
    [manifestPath, "metadata/full-workflow-evidence-manifest.json"],
    [smokePath, "metadata/installed-runtime-smoke.json"],
  ];
  const members: Array<{
    source: string;
    target: string;
    expected: JsonRecord | null;
  }> = [
    ...metadata.map(([source, target]) => ({ source, target, expected: null })),
    ...[...declared.entries()].map(([source, expected], index: number) => ({
      source,
      target: `evidence/${String(index).padStart(4, "0")}-${String(
        expected.sha256,
      )}${extname(source).toLowerCase()}`,
      expected,
    })),
  ];
  if (new Set(members.map(({ target }) => target)).size !== members.length)
    throw new Error("evidence bundle member names collide");

  const snapshots = new Map<string, JsonRecord>();
  for (const member of members) {
    const snapshot = snapshotRegular(member.source, "evidence bundle source");
    if (
      member.expected &&
      (snapshot.byteLength !== member.expected.byteLength ||
        snapshot.sha256 !== member.expected.sha256)
    )
      throw new Error(
        `evidence source digest or size changed: ${member.source}`,
      );
    snapshots.set(member.source, snapshot);
  }
  if (
    Number(snapshots.get(manifestPath)?.byteLength) !==
      manifestFileRaw.byteLength ||
    snapshots.get(manifestPath)?.sha256 !== sha256(manifestFileRaw) ||
    Number(snapshots.get(summaryPath)?.byteLength) !==
      summaryFileRaw.byteLength ||
    snapshots.get(summaryPath)?.sha256 !== sha256(summaryFileRaw)
  )
    throw new Error("validated evidence metadata changed before bundling");

  const parent = dirname(bundleRoot);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".bundle-stage-"));
  const copyFile =
    (dependencies.copyFile as
      | ((source: string, destination: string, index: number) => void)
      | undefined) ??
    ((source: string, destination: string) =>
      copyFileSync(source, destination));
  const publishDirectory =
    (dependencies.publishDirectory as
      | ((source: string, destination: string) => void)
      | undefined) ?? publishDirectoryNoReplace;
  let published = false;
  let publishedIdentity = null;
  try {
    for (const [index, member] of members.entries()) {
      const destination = join(staging, member.target);
      mkdirSync(dirname(destination), { recursive: true });
      copyFile(member.source, destination, index);
      const staged = snapshotRegular(
        destination,
        "staged evidence bundle member",
      );
      const expected =
        member.expected ?? snapshots.get(member.source) ?? null;
      if (!expected) throw new Error("staged evidence snapshot is missing");
      if (
        Number(staged.byteLength) !== Number(expected.byteLength) ||
        staged.sha256 !== expected.sha256
      )
        throw new Error(
          `staged evidence digest or size changed: ${member.target}`,
        );
    }

    for (const member of members) {
      const sourceSnapshot = snapshots.get(member.source);
      if (!sourceSnapshot) throw new Error("evidence source snapshot is missing");
      assertSnapshot(
        sourceSnapshot,
        member.expected,
        "evidence bundle source",
      );
    }
    const expectedPaths = members.map(({ target }) => target).sort();
    const actualPaths = filesRecursively(staging).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
      throw new Error("staged evidence bundle member set is not exact");
    for (const member of members) {
      const staged = snapshotRegular(
        join(staging, member.target),
        "staged evidence bundle member",
      );
      const expected =
        member.expected ?? snapshots.get(member.source) ?? null;
      if (!expected) throw new Error("staged evidence snapshot is missing");
      if (
        Number(staged.byteLength) !== Number(expected.byteLength) ||
        staged.sha256 !== expected.sha256
      )
        throw new Error(
          `staged evidence digest or size changed: ${member.target}`,
        );
    }
    fsyncDirectory(staging);
    const stagedRootIdentity = inodeIdentity(
      lstatSync(staging, { bigint: true }),
    );
    publishedIdentity = stagedRootIdentity;
    if (existsSync(bundleRoot))
      throw new Error(`evidence bundle destination exists: ${bundleRoot}`);
    publishDirectory(staging, bundleRoot);
    published = true;
    const publishedStat = lstatSync(bundleRoot, { bigint: true });
    if (
      publishedStat.isSymbolicLink() ||
      !publishedStat.isDirectory() ||
      inodeIdentity(publishedStat) !== stagedRootIdentity
    )
      throw new Error("published evidence bundle is not the staged directory");
    return { bundleRoot, files: expectedPaths };
  } catch (error) {
    if (published && existsSync(bundleRoot)) {
      const current = lstatSync(bundleRoot, { bigint: true });
      if (
        !current.isSymbolicLink() &&
        current.isDirectory() &&
        inodeIdentity(current) === publishedIdentity
      )
        rmSync(bundleRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main(args: string[]): void {
  const allowIncomplete = args.includes("--allow-incomplete");
  const positional = args.filter((arg) => arg !== "--allow-incomplete");
  if (
    positional.length !== 8 ||
    positional[0] !== "--manifest" ||
    positional[2] !== "--summary" ||
    positional[4] !== "--smoke" ||
    positional[6] !== "--out"
  )
    throw new Error(
      "usage: --manifest <absolute-path> --summary <absolute-path> --smoke <absolute-path> --out <absolute-path> [--allow-incomplete]",
    );
  createFullWorkflowEvidenceBundle({
    manifestPath: positional[1],
    summaryPath: positional[3],
    smokePath: positional[5],
    bundleRoot: positional[7],
    allowIncomplete,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
