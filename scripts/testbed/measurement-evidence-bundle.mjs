import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const schemaVersion = "vem-ai-regional-measurement-transport/v1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
const canonical = (value) => `${JSON.stringify(sorted(value), null, 2)}\n`;
function file(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`${label} must be regular`);
  const bytes = readFileSync(path);
  return { bytes, byteSize: bytes.length, sha256: sha(bytes) };
}
function list(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return list(root, name);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("measurement source contains unsafe member");
      return [name];
    },
  );
}
export function createMeasurementEvidenceBundle({
  measurementPath,
  reportPath,
  aggregatePath,
  manifestPath,
  sourceRoot,
  bundleRoot,
}) {
  for (const value of [
    measurementPath,
    reportPath,
    aggregatePath,
    manifestPath,
    sourceRoot,
    bundleRoot,
  ])
    if (!isAbsolute(value))
      throw new Error("measurement bundle paths must be absolute");
  if (existsSync(bundleRoot))
    throw new Error("measurement bundle destination exists");
  const measurement = JSON.parse(file(measurementPath, "measurement").bytes);
  if (
    measurement.schemaVersion !== "vem-ai-regional-measurement/v1" ||
    measurement.status !== "measured_not_accepted" ||
    measurement.acceptancePassed !== false ||
    measurement.calibrationRequired !== true
  )
    throw new Error("measurement is not canonical pending output");
  const sourceMembers = list(sourceRoot).sort();
  if (
    sourceMembers.length !== 8 ||
    !sourceMembers.includes("calibration-source-input.json")
  )
    throw new Error("measurement source must be exact-eight");
  const sources = [
    [measurementPath, "measurement/ai-regional-measurement.json"],
    [reportPath, "metadata/ai-virtual-try-on.json"],
    [aggregatePath, "metadata/full-workflow-tracks.json"],
    [manifestPath, "metadata/full-workflow-evidence-manifest.json"],
    ...sourceMembers.map((name) => [
      join(sourceRoot, name),
      `calibration-source/${name}`,
    ]),
  ];
  const inventory = sources.map(([source, name]) => ({
    name,
    ...file(source, `measurement member ${name}`),
  }));
  const parent = dirname(bundleRoot);
  mkdirSync(parent, { recursive: true });
  const staging = `${bundleRoot}.stage`;
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  try {
    for (const [source, name] of sources) {
      const target = join(staging, name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
      const copied = file(target, "staged measurement member");
      const expected = inventory.find((member) => member.name === name);
      if (
        copied.sha256 !== expected.sha256 ||
        copied.byteSize !== expected.byteSize
      )
        throw new Error("measurement member changed during bundle");
    }
    writeFileSync(
      join(staging, "transport-manifest.json"),
      canonical({
        schemaVersion,
        acceptanceUploadable: false,
        inventory: inventory.map(({ name, byteSize, sha256 }) => ({
          name,
          byteSize,
          sha256,
        })),
      }),
    );
    renameSync(staging, bundleRoot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { inventory };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = Object.fromEntries(
    Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
      process.argv[2 + i * 2].slice(2),
      process.argv[3 + i * 2],
    ]),
  );
  try {
    createMeasurementEvidenceBundle({
      measurementPath: args.measurement,
      reportPath: args.report,
      aggregatePath: args.aggregate,
      manifestPath: args.manifest,
      sourceRoot: args.source,
      bundleRoot: args.out,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
