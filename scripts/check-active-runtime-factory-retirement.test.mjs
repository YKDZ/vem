import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const activeRuntimeFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/vm-runtime-acceptance.yml",
  "package.json",
  "tools/check-ci.mjs",
  "public/managed-machine-update.md",
  "public/machine-provisioning-default-api-base-url.md",
  "public/maintenance-relay-bring-up.md",
  "public/near-field-customer-speaker-acceptance.md",
  "public/unified-field-delivery.md",
  "public/windows-bringup-bundle.md",
];

const runtimeEntrypoints = [
  "scripts/testbed/win10-vem-e2e.mjs",
  "scripts/testbed/run-vm-host-adapter.mjs",
  "scripts/testbed/kvm-baseline/build-win10-baseline.mjs",
  "scripts/testbed/kvm-baseline/linux-kvm-baseline.mjs",
  "scripts/testbed/kvm-baseline/libvirt-runtime-profile.mjs",
  "scripts/windows/runtime-artifact-descriptor.mjs",
  "scripts/windows/test-vision-candidate.ps1",
  "scripts/windows/test-vision-candidate.windows-harness.ps1",
  "scripts/windows/verify-vem-runtime.ps1",
];

const activeRuntimeForbiddenPatterns = [
  /\bFactory Image Acceptance\b/,
  /\bFactory ISO\b/,
  /\bFactory Manifest\b/,
  /\bFactory Personalization Media\b/,
  /\bmanaged-update\b/i,
  /\bapply-managed-update\b/,
  /\bbuild-factory-iso\b/,
  /\bfactory-image-acceptance\b/,
  /\bprepare-factory-runtime\b/,
  /\bverify-factory-runtime\b/,
  /\bprovision-vision-factory-release\b/,
  /\bWireGuard\b/,
  /\bTailscale\b/,
  /\bVPS\b/,
  /\bCOM[35]\b/,
  /118\.25\.104\.160/,
  /100\.66\.207\.119/,
  /100\.68\.189\.11/,
];

const activeWorkflowForbiddenPatterns = [
  /scripts\/factory\//,
  /build-factory-iso/,
  /factory-image-acceptance/,
  /prepare-factory-runtime/,
  /verify-factory-runtime/,
  /provision-vision-factory-release/,
  /machine-config\.bringup/,
  /\bCOM[0-9]\b/,
];

function activeWorkflows() {
  return readdirSync(".github/workflows")
    .filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))
    .filter((path) =>
      /^on:/m.test(readFileSync(join(".github/workflows", path), "utf8")),
    )
    .map((path) => join(".github/workflows", path));
}

function localImports(text) {
  const imports = [];
  for (const match of text.matchAll(
    /\bimport\s*(?:[\w*${},\s]*\sfrom\s*)?["']([^"']+)["']/g,
  )) {
    imports.push(match[1]);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push(match[1]);
  }
  return imports;
}

function runtimeImportClosure(entrypoint) {
  const pending = [entrypoint];
  const closure = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    const text = readFileSync(path, "utf8");
    for (const imported of localImports(text)) {
      if (!imported.startsWith(".")) continue;
      const resolved = resolve(dirname(path), imported);
      const candidate = [
        resolved,
        `${resolved}.mjs`,
        `${resolved}.js`,
        join(resolved, "index.mjs"),
        join(resolved, "index.js"),
      ].find((candidatePath) => existsSync(candidatePath));
      if (candidate) pending.push(candidate);
    }
  }
  return closure;
}

describe("active Windows runtime Factory retirement guard", () => {
  it("recognizes side-effect, multiline, and dynamic local imports", () => {
    assert.deepEqual(
      localImports(`
        import "./side-effect.mjs";
        import {
          adapter,
        } from
          "./multiline.mjs";
        await import(
          "./dynamic.mjs"
        );
      `),
      ["./side-effect.mjs", "./multiline.mjs", "./dynamic.mjs"],
    );
  });

  for (const path of activeRuntimeFiles) {
    it(`${path} does not describe or invoke stopped Factory paths`, () => {
      const text = readFileSync(path, "utf8");
      for (const pattern of activeRuntimeForbiddenPatterns) {
        assert.doesNotMatch(text, pattern, `${path} matched ${pattern}`);
      }
    });
  }

  for (const path of activeWorkflows()) {
    it(`${path} has no retired Factory or fixed-config execution path`, () => {
      const text = readFileSync(path, "utf8");
      for (const pattern of activeWorkflowForbiddenPatterns) {
        assert.doesNotMatch(text, pattern, `${path} matched ${pattern}`);
      }
    });
  }

  for (const path of runtimeEntrypoints) {
    it(`${path} and its transitive imports exclude historical Factory source`, () => {
      for (const importedPath of runtimeImportClosure(path)) {
        const text = readFileSync(importedPath, "utf8");
        for (const imported of localImports(text)) {
          assert.doesNotMatch(
            imported,
            /(?:^|\/)factory(?:\/|$)/,
            `${importedPath} imports retired Factory source: ${imported}`,
          );
        }
      }
    });
  }

  it("removes retired workflow entrypoints and active runbook inventory", () => {
    for (const path of [
      ".github/workflows/build-factory-iso.yml",
      ".github/workflows/factory-image-acceptance.yml",
      "scripts/windows/prepare-unified-field-delivery.mjs",
      "scripts/windows/prepare-unified-field-delivery.test.mjs",
    ]) {
      assert.equal(existsSync(path), false, `${path} must remain disabled`);
    }
    const inventory = readFileSync(
      "scripts/check-repository-script-inventory.mjs",
      "utf8",
    );
    for (const path of [
      "public/customer-accessible-kiosk-lockdown.md",
      "public/production-pilot-sop.md",
      "public/vision-release-bundle.md",
    ]) {
      assert.doesNotMatch(
        inventory,
        new RegExp(`path: ${JSON.stringify(path)}`),
        `${path} must not be an active public runbook`,
      );
    }
  });
});
