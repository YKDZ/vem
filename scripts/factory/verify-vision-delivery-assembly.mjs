#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FACTORY_INSTALLER_MEMBERS = Object.freeze([
  "install-vision-release.ps1",
  "provision-vision-factory-release.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
]);

export const PREAPPROVAL_MEMBERS = Object.freeze([
  "bundle.bin",
  "vision-release-descriptor.json",
  "test-vision-candidate.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
]);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readRegularFile(path, label) {
  const stat = lstatSync(path);
  assert.equal(stat.isFile(), true, `${label} must be a regular file`);
  return readFileSync(path);
}

function listedDeliveryFiles(root, prefix = "") {
  const files = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relative));
    if (stat.isDirectory()) files.push(...listedDeliveryFiles(root, relative));
    else {
      assert.equal(stat.isFile(), true, `${relative} must be a regular file`);
      files.push(relative);
    }
  }
  return files;
}

function assertSafeDeliveryRelativePath(relative) {
  assert.match(
    relative,
    /^(VISION-RELEASE|VISION-TRUST|VISION-INSTALLER)\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
    `invalid Factory delivery member: ${relative}`,
  );
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value ?? {}).sort(),
    [...expected].sort(),
    `${label} member set is not exact`,
  );
}

export function verifyFactoryVisionDelivery(root) {
  const deliveryRoot = resolve(root);
  const manifestPath = join(deliveryRoot, "VISION-FACTORY-PROVISIONING.JSON");
  const manifestBytes = readRegularFile(
    manifestPath,
    "Factory provisioning manifest",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, "vem-vision-factory-provisioning/v1");
  assert.equal(manifest.kind, "vision-factory-provisioning");
  assert.equal(typeof manifest.files, "object");
  const manifestMembers = Object.keys(manifest.files ?? {}).sort();
  assert.ok(
    manifestMembers.length > 0,
    "Factory manifest has no delivery files",
  );
  for (const relative of manifestMembers) {
    assertSafeDeliveryRelativePath(relative);
    assert.match(manifest.files[relative], /^sha256:[a-f0-9]{64}$/);
  }
  const physicalMembers = [
    ...listedDeliveryFiles(deliveryRoot, "VISION-RELEASE"),
    ...listedDeliveryFiles(deliveryRoot, "VISION-TRUST"),
    ...listedDeliveryFiles(deliveryRoot, "VISION-INSTALLER"),
  ].sort();
  assert.deepEqual(
    physicalMembers,
    manifestMembers,
    "Factory provisioning manifest member set is not exact",
  );

  const files = {};
  for (const relative of manifestMembers) {
    const bytes = readRegularFile(join(deliveryRoot, relative), relative);
    assert.equal(
      manifest.files[relative],
      digest(bytes),
      `${relative} digest does not bind its staged bytes`,
    );
    files[relative] = manifest.files[relative];
  }
  for (const name of FACTORY_INSTALLER_MEMBERS) {
    assert.ok(
      Object.hasOwn(files, `VISION-INSTALLER/${name}`),
      `Factory provisioning is missing executable installer ${name}`,
    );
  }
  return {
    schemaVersion: "vem-vision-delivery-assembly-evidence/v1",
    kind: "factory-vision-delivery-assembly",
    artifact: "VISION-FACTORY-PROVISIONING.JSON",
    artifactDigest: digest(manifestBytes),
    files,
  };
}

export function verifyPreapprovalDelivery(root) {
  const deliveryRoot = resolve(root);
  const manifestPath = join(deliveryRoot, "preapproval-manifest.json");
  const manifestBytes = readRegularFile(manifestPath, "Preapproval manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, "vem-vision-preapproval-delivery/v1");
  assert.equal(manifest.kind, "vision-preapproval-delivery");
  assertExactKeys(manifest.files, PREAPPROVAL_MEMBERS, "Preapproval delivery");

  const files = {};
  for (const name of PREAPPROVAL_MEMBERS) {
    const bytes = readRegularFile(join(deliveryRoot, name), name);
    assert.equal(
      manifest.files[name],
      digest(bytes),
      `${name} digest does not bind its staged bytes`,
    );
    files[name] = manifest.files[name];
  }
  return {
    schemaVersion: "vem-vision-delivery-assembly-evidence/v1",
    kind: "vision-preapproval-delivery-assembly",
    artifact: "preapproval-manifest.json",
    artifactDigest: digest(manifestBytes),
    files,
  };
}

function usage() {
  return "verify-vision-delivery-assembly.mjs --kind factory|preapproval --root DIR";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kindIndex = process.argv.indexOf("--kind");
  const rootIndex = process.argv.indexOf("--root");
  const kind = kindIndex >= 0 ? process.argv[kindIndex + 1] : undefined;
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  try {
    if (!root || !["factory", "preapproval"].includes(kind)) {
      throw new Error(usage());
    }
    const evidence =
      kind === "factory"
        ? verifyFactoryVisionDelivery(root)
        : verifyPreapprovalDelivery(root);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
