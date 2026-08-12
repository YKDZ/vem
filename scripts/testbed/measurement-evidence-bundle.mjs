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
function parse(path, label) {
  try {
    return JSON.parse(file(path, label).bytes);
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}
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
        bindings: {
          reportSha256: inventory.find(
            (member) => member.name === "metadata/ai-virtual-try-on.json",
          ).sha256,
          sourceInputSha256: inventory.find(
            (member) =>
              member.name ===
              "calibration-source/calibration-source-input.json",
          ).sha256,
        },
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
export function validateMeasurementEvidenceTransport(bundleRoot) {
  if (!isAbsolute(bundleRoot))
    throw new Error("measurement transport root must be absolute");
  const transport = parse(
    join(bundleRoot, "transport-manifest.json"),
    "transport manifest",
  );
  if (
    transport?.schemaVersion !== schemaVersion ||
    transport.acceptanceUploadable !== false ||
    !Array.isArray(transport.inventory) ||
    !/^[a-f0-9]{64}$/.test(transport.bindings?.reportSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(transport.bindings?.sourceInputSha256 ?? "")
  )
    throw new Error("transport manifest is invalid");
  for (const member of transport.inventory) {
    if (
      !member?.name ||
      !Number.isSafeInteger(member.byteSize) ||
      !/^[a-f0-9]{64}$/.test(member.sha256 ?? "")
    )
      throw new Error("transport inventory is invalid");
    const actual = file(
      resolve(bundleRoot, member.name),
      "transport inventory member",
    );
    if (actual.byteSize !== member.byteSize || actual.sha256 !== member.sha256)
      throw new Error("transport inventory identity mismatched");
  }
  const measurement = parse(
    join(bundleRoot, "measurement/ai-regional-measurement.json"),
    "measurement",
  );
  const report = parse(
    join(bundleRoot, "metadata/ai-virtual-try-on.json"),
    "AI report",
  );
  const aggregate = parse(
    join(bundleRoot, "metadata/full-workflow-tracks.json"),
    "aggregate",
  );
  const manifest = parse(
    join(bundleRoot, "metadata/full-workflow-evidence-manifest.json"),
    "evidence manifest",
  );
  if (
    measurement.status !== "measured_not_accepted" ||
    measurement.acceptancePassed !== false ||
    measurement.calibrationRequired !== true
  )
    throw new Error("measurement pending contract is invalid");
  const pending =
    "AI regional evidence policy awaits Issue10 two-garment calibration";
  const incomplete = "AI virtual try-on acceptance evidence is incomplete";
  if (report.ok !== false || report.error !== pending)
    throw new Error("AI report is not exact calibration pending");
  const tracks = aggregate?.execution?.executedTracks;
  const failures = aggregate?.failures;
  const ai = aggregate?.businessSets?.aiVirtualTryOn;
  if (
    aggregate?.ok !== false ||
    aggregate?.businessOutcome?.ok !== false ||
    !Array.isArray(tracks) ||
    !Array.isArray(failures) ||
    ai?.status !== "failed" ||
    ai?.reason !== incomplete
  )
    throw new Error("aggregate pending contract is invalid");
  if (
    failures.length !== 2 ||
    !failures.some(
      (failure) =>
        failure?.set === "aiVirtualTryOn" && failure?.reason === incomplete,
    ) ||
    !failures.some(
      (failure) =>
        failure?.set === "evidenceInventory" && failure?.reason === pending,
    )
  )
    throw new Error("aggregate has unexpected failure");
  if (
    tracks.length !== 1 ||
    tracks[0]?.key !== "aiVirtualTryOn" ||
    tracks[0]?.status !== "failed" ||
    tracks[0]?.businessStatus !== "failed" ||
    tracks[0]?.reportOk !== false ||
    tracks[0]?.failureStage !== "child" ||
    tracks[0]?.validator?.status !== "failed" ||
    tracks[0]?.validator?.reason !== incomplete ||
    tracks[0]?.terminal?.ok !== true ||
    tracks[0]?.handoffRecovery?.ok !== true
  )
    throw new Error(
      "measurement execution track is not exact pending lifecycle",
    );
  if (
    tracks.some(
      (track) =>
        track?.failureStage === "infrastructure" ||
        track?.businessStatus === "infrastructure_failed" ||
        (track?.key !== "aiVirtualTryOn" && track?.error != null),
    )
  )
    throw new Error("aggregate has infrastructure or other-track failure");
  if (
    aggregate?.evidenceInventory?.ok !== false ||
    JSON.stringify(aggregate?.evidenceInventory?.failures) !==
      JSON.stringify([pending]) ||
    manifest?.ok !== true ||
    !aggregate?.evidenceInventory?.manifestFile
  )
    throw new Error("measurement evidence manifest is invalid");
  const manifestIdentity = file(
    join(bundleRoot, "metadata/full-workflow-evidence-manifest.json"),
    "evidence manifest",
  );
  if (
    aggregate.evidenceInventory.manifestFile.sha256 !==
      manifestIdentity.sha256 ||
    aggregate.evidenceInventory.manifestFile.byteLength !==
      manifestIdentity.byteSize
  )
    throw new Error("aggregate manifest identity mismatched");
  const sourceInput = file(
    join(bundleRoot, "calibration-source/calibration-source-input.json"),
    "calibration source input",
  );
  const reportIdentity = file(
    join(bundleRoot, "metadata/ai-virtual-try-on.json"),
    "AI report",
  );
  if (
    measurement.calibrationSourceBundle?.members?.length !== 8 ||
    transport.bindings.sourceInputSha256 !== sourceInput.sha256 ||
    transport.bindings.reportSha256 !== reportIdentity.sha256
  )
    throw new Error("measurement source cross-binding is invalid");
  return { measurement, report, aggregate, manifest };
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
