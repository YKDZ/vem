import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const activeRuntimeFiles = [
  ".github/workflows/ci.yml",
  "package.json",
  "tools/check-ci.mjs",
];

const runtimeEntrypoints = [
  "scripts/testbed/local-testbed.mjs",
  "scripts/testbed/local-testbed-host.mjs",
  "scripts/testbed/installed-runtime-smoke.mjs",
  "scripts/testbed/run-local-testbed-guest.ps1",
  "scripts/testbed/run-vm-host-adapter.mjs",
  "scripts/testbed/kvm-baseline/build-win10-baseline.mjs",
  "scripts/testbed/kvm-baseline/linux-kvm-baseline.mjs",
  "scripts/testbed/kvm-baseline/libvirt-runtime-profile.mjs",
  "scripts/windows/runtime-artifact-descriptor.mjs",
  "scripts/windows/get-vision-main-artifacts.ps1",
  "scripts/windows/install-vision-main-artifact.ps1",
  "scripts/windows/verify-vem-runtime.ps1",
  "scripts/testbed/windows-native-audio-evidence.mjs",
  ...directScriptEntrypoints(".github/workflows/ci.yml"),
  ...directScriptEntrypoints("tools/check-ci.mjs"),
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

function directScriptEntrypoints(path) {
  return [
    ...readFileSync(path, "utf8").matchAll(
      /(?:^|[\s"'`])(?:\.\/)?((?:scripts|tools)\/[\w./-]+\.(?:c?js|mjs|ps1|psm1))/g,
    ),
  ].map((match) => match[1]);
}

function javascriptImports(text) {
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

function powerShellImports(text) {
  const imports = [];
  const source = text.replace(/^\s*#.*$/gm, "");
  const localVariables = new Map(
    [
      ...source.matchAll(
        /^\s*\$(\w+)\s*=\s*(?:Join-Path\s+\$PSScriptRoot\s+)?["']([^"']+)["']/gim,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  for (const pattern of [
    /\bImport-Module\s+(?:\(\s*)?(?:Join-Path\s+\$PSScriptRoot\s+)?["']([^"']+)["']/gi,
    /^\s*\.\s+(?:\(\s*)?(?:Join-Path\s+\$PSScriptRoot\s+)?["']([^"']+)["']/gim,
    /\bImport-Module\s+["']\$PSScriptRoot[\\/]+([^"']+)["']/gi,
    /^\s*\.\s+["']\$PSScriptRoot[\\/]+([^"']+)["']/gim,
  ]) {
    for (const match of source.matchAll(pattern)) imports.push(match[1]);
  }
  for (const pattern of [
    /\bImport-Module\s+\$(\w+)/gi,
    /^\s*\.\s+\$(\w+)/gim,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const imported = localVariables.get(match[1]);
      if (imported) imports.push(imported);
    }
  }
  return imports;
}

function localImports(path, text) {
  return /\.ps(?:1|m1)$/i.test(path)
    ? powerShellImports(text)
    : javascriptImports(text);
}

function runtimeImportClosure(entrypoint, root = process.cwd()) {
  const pending = [resolve(root, entrypoint)];
  const closure = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    const text = readFileSync(path, "utf8");
    for (const imported of localImports(path, text)) {
      if (!imported.startsWith(".") && !/\.ps(?:1|m1)$/i.test(path)) continue;
      const resolved = resolve(dirname(path), imported);
      const candidate = [
        resolved,
        `${resolved}.mjs`,
        `${resolved}.js`,
        `${resolved}.ps1`,
        `${resolved}.psm1`,
        join(resolved, "index.mjs"),
        join(resolved, "index.js"),
      ].find((candidatePath) => existsSync(candidatePath));
      if (candidate) pending.push(candidate);
    }
  }
  return closure;
}

function assertNoFactoryImports(entrypoint, root = process.cwd()) {
  for (const importedPath of runtimeImportClosure(entrypoint, root)) {
    const text = readFileSync(importedPath, "utf8");
    for (const imported of localImports(importedPath, text)) {
      assert.doesNotMatch(
        imported,
        /(?:^|[\\/])factory(?:[\\/]|$)/,
        `${relative(root, importedPath)} imports retired Factory source: ${imported}`,
      );
    }
  }
}

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), "vem-factory-retirement-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const filePath = join(root, path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("active Windows runtime Factory retirement guard", () => {
  it("recognizes side-effect, multiline, and dynamic local imports", () => {
    assert.deepEqual(
      localImports(
        "entry.mjs",
        `
        import "./side-effect.mjs";
        import {
          adapter,
        } from
          "./multiline.mjs";
        await import(
          "./dynamic.mjs"
        );
      `,
      ),
      ["./side-effect.mjs", "./multiline.mjs", "./dynamic.mjs"],
    );
  });

  it("recognizes PowerShell module imports and dot-sourced local scripts", () => {
    assert.deepEqual(
      localImports(
        "entry.ps1",
        `
          $modulePath = Join-Path $PSScriptRoot "runtime.psm1"
          $supportPath = Join-Path $PSScriptRoot "support.ps1"
          Import-Module $modulePath -Force
          . $supportPath
        `,
      ),
      ["runtime.psm1", "support.ps1"],
    );
  });

  it("rejects a PowerShell entrypoint with a transitive Factory import", () => {
    withFixture(
      {
        "entry.ps1":
          'Import-Module (Join-Path $PSScriptRoot "runtime.psm1") -Force',
        "runtime.psm1": '. (Join-Path $PSScriptRoot "../factory/legacy.ps1")',
        "factory/legacy.ps1": "Write-Output legacy",
      },
      (root) => {
        assert.throws(
          () => assertNoFactoryImports("entry.ps1", root),
          /runtime\.psm1 imports retired Factory source: \.\.\/factory\/legacy\.ps1/,
        );
      },
    );
  });

  it("keeps legacy and Factory-dependent acceptance scripts out of active runtime inventory", () => {
    const inventory = readFileSync(
      "scripts/check-repository-script-inventory.mjs",
      "utf8",
    );
    for (const path of [
      "scripts/testbed/factory-image-acceptance.mjs",
      "scripts/testbed/factory-maintenance-relay-attestation.mjs",
      "scripts/windows/prepare-factory-runtime.ps1",
      "scripts/windows/verify-factory-runtime.ps1",
      "scripts/windows/verify-progressive-delivery.mjs",
      "scripts/windows/verify-progressive-delivery.test.mjs",
    ]) {
      const escaped = path.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
      const block = inventory.match(
        new RegExp(`path: \"${escaped}\"[\\s\\S]*?\\n  \\},`),
      )?.[0];
      assert.equal(
        block,
        undefined,
        `retired path must not be retained: ${path}`,
      );
    }
    assert.match(
      inventory,
      /path: "scripts\/testbed\/installed-kiosk-sale-acceptance\.mjs"[\s\S]*?runtime acceptance/,
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

  for (const path of [...new Set(runtimeEntrypoints)]) {
    it(`${path} and its transitive imports exclude historical Factory source`, () => {
      assertNoFactoryImports(path);
    });
  }

  it("removes retired workflow entrypoints", () => {
    for (const path of [
      ".github/workflows/build-factory-iso.yml",
      ".github/workflows/factory-image-acceptance.yml",
      "scripts/windows/prepare-unified-field-delivery.mjs",
      "scripts/windows/prepare-unified-field-delivery.test.mjs",
      "scripts/windows/install-vision-release.ps1",
      "scripts/windows/provision-vision-factory-release.ps1",
      "scripts/windows/test-vision-candidate.ps1",
      "scripts/windows/vision-release-materialization.psm1",
    ]) {
      assert.equal(existsSync(path), false, `${path} must remain disabled`);
    }
  });
});
