#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${token}`);
    }
    options[token.slice(2)] = argv[++index];
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function normalizeSha(value, label) {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be a 64-hex SHA-256`);
  }
  return digest;
}

function normalizePrefixed(value, label) {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  }
  return digest;
}

function addCheck(checks, stage, name, passed, detail) {
  checks.push({ stage, name, passed, detail });
}

function expectRole(manifest, role) {
  const asset = manifest.assets.find((entry) => entry.role === role);
  if (!asset) {
    throw new Error(`factory manifest is missing asset role: ${role}`);
  }
  return asset;
}

function validateFactoryManifestLight(manifest) {
  if (
    manifest?.schemaVersion !== "vem-factory-manifest/v1" ||
    manifest?.kind !== "factory-manifest" ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error("factory manifest contract is invalid");
  }
  return manifest;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.candidate) {
    throw new Error("--candidate is required");
  }
  const candidate = readJson(options.candidate);
  const checks = [];
  const daemonSha = normalizePrefixed(
    candidate.runtime?.artifacts?.["vem-daemon"]?.digest,
    "candidate daemon digest",
  );
  const machineSha = normalizePrefixed(
    candidate.runtime?.artifacts?.["vem-machine-ui"]?.digest,
    "candidate machine UI digest",
  );
  const webviewSha = normalizePrefixed(
    candidate.runtime?.artifacts?.["webview2-loader"]?.digest,
    "candidate WebView2 digest",
  );
  const visionSha = candidate.vision?.bundleDigest
    ? normalizePrefixed(candidate.vision.bundleDigest, "candidate Vision digest")
    : null;

  if (options["vm-runtime-acceptance"]) {
    const vm = readJson(options["vm-runtime-acceptance"]);
    addCheck(
      checks,
      "L2_windows_vm",
      "daemon-sha256",
      normalizeSha(vm.artifacts?.daemonSha256, "VM acceptance daemon") ===
        daemonSha.slice(7),
      "VM acceptance daemonSha256 must equal unified delivery runtime artifact",
    );
    addCheck(
      checks,
      "L2_windows_vm",
      "machine-ui-sha256",
      normalizeSha(vm.artifacts?.machineUiSha256, "VM acceptance machine UI") ===
        machineSha.slice(7),
      "VM acceptance machineUiSha256 must equal unified delivery runtime artifact",
    );
  }

  if (options["managed-update-manifest"] && options["managed-update-evidence"]) {
    const manifest = readJson(options["managed-update-manifest"]);
    const evidence = readJson(options["managed-update-evidence"]);
    const sourceBinding = evidence.sourceBinding ?? {};
    const daemon = manifest.components.find((entry) => entry.component === "daemon");
    const ui = manifest.components.find((entry) => entry.component === "ui");
    addCheck(
      checks,
      "L3_non_iso_field",
      "manifest-source-commit",
      String(manifest.sourceCommit).toLowerCase() ===
        String(candidate.sourceCommit).toLowerCase(),
      "managed-update manifest sourceCommit must equal unified delivery sourceCommit",
    );
    addCheck(
      checks,
      "L3_non_iso_field",
      "daemon-component-hash",
      normalizeSha(daemon?.sha256, "managed-update daemon sha256") ===
        daemonSha.slice(7),
      "managed-update daemon component must bind the unified delivery daemon bytes",
    );
    addCheck(
      checks,
      "L3_non_iso_field",
      "ui-component-hash",
      normalizeSha(ui?.sha256, "managed-update ui sha256") === machineSha.slice(7),
      "managed-update UI component must bind the unified delivery machine UI bytes",
    );
    addCheck(
      checks,
      "L3_non_iso_field",
      "ui-sidecar-hash",
      normalizeSha(
        ui?.sidecars?.[0]?.sha256,
        "managed-update WebView2 sidecar sha256",
      ) === webviewSha.slice(7),
      "managed-update UI sidecar must bind the unified delivery WebView2 bytes",
    );
    addCheck(
      checks,
      "L3_non_iso_field",
      "source-binding-schema",
      sourceBinding.schemaVersion === "managed-update-source-binding/v1",
      "managed-update evidence must retain managed-update-source-binding/v1",
    );
  }

  if (options["factory-manifest"]) {
    const manifest = validateFactoryManifestLight(
      readJson(options["factory-manifest"]),
    );
    addCheck(
      checks,
      "L4_factory_iso",
      "factory-daemon-digest",
      expectRole(manifest, "vem-daemon").digest === daemonSha,
      "Factory Manifest vem-daemon digest must equal the unified delivery daemon digest",
    );
    addCheck(
      checks,
      "L4_factory_iso",
      "factory-machine-ui-digest",
      expectRole(manifest, "vem-machine-ui").digest === machineSha,
      "Factory Manifest vem-machine-ui digest must equal the unified delivery machine UI digest",
    );
    addCheck(
      checks,
      "L4_factory_iso",
      "factory-webview-digest",
      expectRole(manifest, "webview2-loader").digest === webviewSha,
      "Factory Manifest webview2-loader digest must equal the unified delivery WebView2 digest",
    );
    if (visionSha) {
      addCheck(
        checks,
        "L4_factory_iso",
        "factory-vision-digest",
        expectRole(manifest, "vision-release").digest === visionSha,
        "Factory Manifest vision-release digest must equal the unified delivery Vision digest",
      );
    }
  }

  if (options["experimental-acceptance"]) {
    const acceptance = readJson(options["experimental-acceptance"]);
    addCheck(
      checks,
      "Vision_identity",
      "experimental-vision-bundle-digest",
      !visionSha ||
        normalizePrefixed(
          acceptance.bundleDigest,
          "experimental Vision bundle digest",
        ) === visionSha,
      "Experimental Vision acceptance must bind the same candidate digest",
    );
  }

  const ok = checks.every((entry) => entry.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: "vem-progressive-delivery-verification/v1",
        kind: "progressive-delivery-verification",
        ok,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
