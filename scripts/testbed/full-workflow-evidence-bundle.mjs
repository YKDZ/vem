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

import { validateFullWorkflowEvidenceUploadFiles } from "./full-workflow-evidence-manifest.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function statIdentity(stat) {
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

function inodeIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode].join(":");
}

function snapshotRegular(path, label) {
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

function assertSnapshot(snapshot, expected, label) {
  const current = snapshotRegular(snapshot.path, label);
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

function filesRecursively(root, prefix = "") {
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

function fsyncDirectory(path) {
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

function publishDirectoryNoReplace(source, destination) {
  if (process.platform !== "win32")
    throw new Error(
      "exclusive evidence bundle directory publication is unsupported on this platform",
    );
  // MoveFile on Windows fails when the destination already exists. Node's
  // directory rename maps to that no-replace primitive on the guest platform.
  renameSync(source, destination);
}

function validateOptions(options) {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string" || !isAbsolute(value))
      throw new Error(`${name} must be an absolute path`);
  }
}

export function createFullWorkflowEvidenceBundle(options, dependencies = {}) {
  validateOptions(options);
  const manifestPath = resolve(options.manifestPath);
  const summaryPath = resolve(options.summaryPath);
  const smokePath = resolve(options.smokePath);
  const bundleRoot = resolve(options.bundleRoot);
  if (existsSync(bundleRoot))
    throw new Error(`evidence bundle destination exists: ${bundleRoot}`);

  const { manifestFile, summaryFile } = validateFullWorkflowEvidenceUploadFiles(
    manifestPath,
    summaryPath,
  );
  const manifest = manifestFile.value;
  const declared = new Map();
  for (const file of manifest.files) {
    const path = resolve(file.path);
    if (declared.has(path))
      throw new Error(`duplicate evidence source path: ${path}`);
    declared.set(path, file);
  }

  const metadata = [
    [summaryPath, "metadata/full-workflow-tracks.json"],
    [manifestPath, "metadata/full-workflow-evidence-manifest.json"],
    [smokePath, "metadata/installed-runtime-smoke.json"],
  ];
  const members = [
    ...metadata.map(([source, target]) => ({ source, target, expected: null })),
    ...[...declared.entries()].map(([source, expected], index) => ({
      source,
      target: `evidence/${String(index).padStart(4, "0")}-${expected.sha256}${extname(source).toLowerCase()}`,
      expected,
    })),
  ];
  if (new Set(members.map(({ target }) => target)).size !== members.length)
    throw new Error("evidence bundle member names collide");

  const snapshots = new Map();
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
    snapshots.get(manifestPath).byteLength !== manifestFile.raw.byteLength ||
    snapshots.get(manifestPath).sha256 !== sha256(manifestFile.raw) ||
    snapshots.get(summaryPath).byteLength !== summaryFile.raw.byteLength ||
    snapshots.get(summaryPath).sha256 !== sha256(summaryFile.raw)
  )
    throw new Error("validated evidence metadata changed before bundling");

  const parent = dirname(bundleRoot);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".bundle-stage-"));
  const copyFile =
    dependencies.copyFile ??
    ((source, destination) => copyFileSync(source, destination));
  const publishDirectory =
    dependencies.publishDirectory ?? publishDirectoryNoReplace;
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
      const expected = member.expected ?? snapshots.get(member.source);
      if (
        staged.byteLength !== expected.byteLength ||
        staged.sha256 !== expected.sha256
      )
        throw new Error(
          `staged evidence digest or size changed: ${member.target}`,
        );
    }

    for (const member of members)
      assertSnapshot(
        snapshots.get(member.source),
        member.expected,
        "evidence bundle source",
      );
    const expectedPaths = members.map(({ target }) => target).sort();
    const actualPaths = filesRecursively(staging).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
      throw new Error("staged evidence bundle member set is not exact");
    for (const member of members) {
      const staged = snapshotRegular(
        join(staging, member.target),
        "staged evidence bundle member",
      );
      const expected = member.expected ?? snapshots.get(member.source);
      if (
        staged.byteLength !== expected.byteLength ||
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

function main(args) {
  if (
    args.length !== 8 ||
    args[0] !== "--manifest" ||
    args[2] !== "--summary" ||
    args[4] !== "--smoke" ||
    args[6] !== "--out"
  )
    throw new Error(
      "usage: --manifest <absolute-path> --summary <absolute-path> --smoke <absolute-path> --out <absolute-path>",
    );
  createFullWorkflowEvidenceBundle({
    manifestPath: args[1],
    summaryPath: args[3],
    smokePath: args[5],
    bundleRoot: args[7],
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
