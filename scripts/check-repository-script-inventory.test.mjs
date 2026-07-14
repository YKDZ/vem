import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkRepositoryScriptInventory } from "./check-repository-script-inventory.mjs";

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), "vem-script-inventory-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolutePath = join(root, path);
      mkdirSync(join(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("repository script inventory guard", () => {
  it("fails when a retained script is not classified", () => {
    withFixture(
      {
        "scripts/windows/prepare-factory-runtime.ps1": "factory manifest",
        "scripts/windows/unclassified-shortcut.ps1": "Write-Host shortcut",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/prepare-factory-runtime.ps1",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /unclassified script: scripts\/windows\/unclassified-shortcut\.ps1/,
        );
      },
    );
  });

  it("rejects a closure that has no structured verifier evidence, regardless of source text", () => {
    withFixture(
      {
        "scripts/windows/test-vision-candidate.ps1":
          'Import-Module (Join-Path $PSScriptRoot "vision-release-materialization.psm1")',
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
        "scripts/windows/vision-diagnostic-redaction.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/test-vision-candidate.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
              deliveryClosure: [
                "scripts/windows/vision-release-materialization.psm1",
                "scripts/windows/vision-diagnostic-redaction.psm1",
              ],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/windows/vision-diagnostic-redaction.psm1",
              owner: "field-operations",
              category: "test support operation",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /test-vision-candidate\.ps1 delivery closure must declare a classified verifier and exact members/,
        );
      },
    );
  });

  it("does not let a commented PowerShell import satisfy structured closure evidence", () => {
    withFixture(
      {
        "scripts/windows/test-vision-candidate.ps1":
          '# Import-Module (Join-Path $PSScriptRoot "vision-release-materialization.psm1")',
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/test-vision-candidate.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
              deliveryClosure: [
                "scripts/windows/vision-release-materialization.psm1",
              ],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /test-vision-candidate\.ps1 delivery closure must declare a classified verifier and exact members/,
        );
      },
    );
  });

  it("rejects a JavaScript source-shaped producer without machine-readable evidence", () => {
    withFixture(
      {
        "scripts/factory/finalize.mjs":
          'for (const script of ["install-vision-release.ps1", "vision-release-materialization.psm1"]) { stage(`VISION-INSTALLER/${script}`); }',
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
        "scripts/windows/vision-diagnostic-redaction.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/factory/finalize.mjs",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/windows/install-vision-release.ps1",
                "scripts/windows/vision-release-materialization.psm1",
                "scripts/windows/vision-diagnostic-redaction.psm1",
              ],
            },
            {
              path: "scripts/windows/install-vision-release.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-diagnostic-redaction.psm1",
              owner: "field-operations",
              category: "test support operation",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /finalize\.mjs delivery assembly must declare a classified verifier and VEM evidence artifact/,
        );
      },
    );
  });

  it("does not let a dead JavaScript file list satisfy assembly evidence", () => {
    withFixture(
      {
        "scripts/factory/experimental-vision-candidate.mjs": [
          'const installers = ["install-vision-release.ps1", "vision-release-materialization.psm1"];',
          "// stage every installer into VISION-INSTALLER",
        ].join("\n"),
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/factory/experimental-vision-candidate.mjs",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/windows/install-vision-release.ps1",
                "scripts/windows/vision-release-materialization.psm1",
              ],
            },
            {
              path: "scripts/windows/install-vision-release.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /experimental-vision-candidate\.mjs delivery assembly must declare a classified verifier and VEM evidence artifact/,
        );
      },
    );
  });

  it("does not let a commented upload loop satisfy assembly evidence", () => {
    withFixture(
      {
        "scripts/testbed/win10-vem-e2e.mjs": [
          'const FACTORY_SUPPORT_SCRIPT_NAMES = ["install-vision-release.ps1", "vision-release-materialization.psm1"];',
          "// for (const scriptName of FACTORY_SUPPORT_SCRIPT_NAMES) upload(scriptName)",
        ].join("\n"),
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/win10-vem-e2e.mjs",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["factory preparation"],
              deliveryAssemblyAction: "javascript-upload",
              deliveryAssembly: [
                "scripts/windows/install-vision-release.ps1",
                "scripts/windows/vision-release-materialization.psm1",
              ],
            },
            {
              path: "scripts/windows/install-vision-release.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /win10-vem-e2e\.mjs delivery assembly must declare a classified verifier and VEM evidence artifact/,
        );
      },
    );
  });

  it("does not let a PowerShell literal satisfy assembly evidence", () => {
    withFixture(
      {
        "scripts/windows/vision-release-install.windows-harness.ps1": [
          '$installer = "install-vision-release.ps1"',
          '# Copy-Item -LiteralPath "vision-release-materialization.psm1"',
        ].join("\n"),
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1":
          "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/vision-release-install.windows-harness.ps1",
              owner: "field-operations",
              category: "verifier-test guard",
              workflows: ["factory preparation"],
              deliveryAssemblyAction: "powershell-copy",
              deliveryAssembly: [
                "scripts/windows/install-vision-release.ps1",
                "scripts/windows/vision-release-materialization.psm1",
              ],
            },
            {
              path: "scripts/windows/install-vision-release.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /vision-release-install\.windows-harness\.ps1 delivery assembly must declare a classified verifier and VEM evidence artifact/,
        );
      },
    );
  });

  it("fails when structured assembly evidence omits a classified materializer", () => {
    withFixture(
      {
        "scripts/factory/finalize.mjs": "dead source text is intentionally irrelevant",
        "scripts/factory/finalize.test.mjs": "test evidence",
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/factory/finalize.mjs",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/windows/install-vision-release.ps1",
                "scripts/windows/vision-release-materialization.psm1",
              ],
              deliveryAssemblyEvidence: {
                artifact: "VEM/VISION-FACTORY-PROVISIONING.JSON",
                verifier: "scripts/factory/finalize.test.mjs",
                members: ["scripts/windows/install-vision-release.ps1"],
              },
            },
            {
              path: "scripts/factory/finalize.test.mjs",
              owner: "field-operations",
              category: "verifier-test guard",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/install-vision-release.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
            {
              path: "scripts/windows/vision-release-materialization.psm1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });
        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /finalize\.mjs delivery assembly evidence omits classified member: scripts\/windows\/vision-release-materialization\.psm1/,
        );
      },
    );
  });

  it("fails when a factory image preparation script bypasses delivery evidence", () => {
    withFixture(
      {
        "scripts/windows/image-prep-shortcut.ps1":
          "Copy-Item machine.exe C:\\VEM\\bringup\\machine.exe",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/image-prep-shortcut.ps1",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["factory preparation"],
              evidenceRequired: true,
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /image preparation shortcut bypasses factory delivery evidence: scripts\/windows\/image-prep-shortcut\.ps1/,
        );
      },
    );
  });

  it("fails factory preparation entrypoints that omit evidence even without evidenceRequired", () => {
    withFixture(
      {
        "scripts/windows/image-prep-shortcut.ps1":
          "Copy-Item machine.exe C:\\VEM\\bringup\\machine.exe",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/image-prep-shortcut.ps1",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /image preparation shortcut bypasses factory delivery evidence: scripts\/windows\/image-prep-shortcut\.ps1/,
        );
      },
    );
  });

  it("requires evidence for explicitly maintained legacy operations", () => {
    withFixture(
      {
        "scripts/windows/legacy-shortcut.ps1": "Write-Host legacy",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/legacy-shortcut.ps1",
              owner: "machine-runtime",
              category: "explicitly maintained legacy operation",
              workflows: ["smoke"],
            },
          ],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /scripts\/windows\/legacy-shortcut\.ps1 legacy operation missing maintainedReference or runbook\/package\/acceptance\/verifier evidence/,
        );
      },
    );
  });

  it("does not accept runbook references that only mention the script filename", () => {
    withFixture(
      {
        "public/runtime.md":
          "Run `verify-vem-runtime.ps1` from wherever you staged it.",
        "scripts/windows/verify-vem-runtime.ps1": "Write-Host verify",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/verify-vem-runtime.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [
            {
              path: "public/runtime.md",
              scripts: ["scripts/windows/verify-vem-runtime.ps1"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/runtime\.md should reference scripts\/windows\/verify-vem-runtime\.ps1/,
        );
      },
    );
  });

  it("accepts explicit deployed Windows script paths in public runbooks", () => {
    withFixture(
      {
        "public/runtime.md":
          "Run `C:\\VEM\\bringup\\scripts\\verify-vem-runtime.ps1` after the managed update.",
        "scripts/windows/verify-vem-runtime.ps1": "Write-Host verify",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/verify-vem-runtime.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [
            {
              path: "public/runtime.md",
              scripts: ["scripts/windows/verify-vem-runtime.ps1"],
            },
          ],
        });

        assert.equal(
          result.checks.find(
            (check) => check.name === "public-runbooks-match-retained-scripts",
          )?.passed,
          true,
        );
        assert.doesNotMatch(
          result.failures.join("\n"),
          /public\/runtime\.md should reference scripts\/windows\/verify-vem-runtime\.ps1/,
        );
      },
    );
  });

  it("marks the runbook summary line failed when a runbook script path is missing", () => {
    withFixture(
      {
        "public/runtime.md":
          "Run `verify-vem-runtime.ps1` from wherever you staged it.",
        "scripts/windows/verify-vem-runtime.ps1": "Write-Host verify",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/verify-vem-runtime.ps1",
              owner: "field-operations",
              category: "public runbook operation",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [
            {
              path: "public/runtime.md",
              scripts: ["scripts/windows/verify-vem-runtime.ps1"],
            },
          ],
        });

        assert.equal(
          result.checks.find(
            (check) => check.name === "public-runbooks-match-retained-scripts",
          )?.passed,
          false,
        );
      },
    );
  });

  it("fails when a public runbook omits a required structured contract", () => {
    withFixture(
      {
        "public/clean-base.md": "Clean-base preparation starts here.",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [
            {
              path: "public/clean-base.md",
              scripts: [],
              requiredContracts: [
                {
                  schemaVersion: "clean-base-source-contract/v1",
                  requiredFields: {
                    "iso.fileNameEvidenceField": "source.iso.fileName",
                  },
                },
              ],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/clean-base\.md missing required runbook contract: clean-base-source-contract\/v1/,
        );
      },
    );
  });

  it("fails when a public runbook omits required maintenance ingress language", () => {
    withFixture(
      {
        "public/production.md": "Use emergency Tailscale SSH.",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [
            {
              path: "public/production.md",
              scripts: [],
              requiredText: [
                "Controlled Maintenance Ingress",
                "Maintenance Relay",
              ],
              forbiddenText: ["Tailscale SSH"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/production\.md missing required runbook text: Controlled Maintenance Ingress/,
        );
        assert.match(
          result.failures.join("\n"),
          /public\/production\.md missing required runbook text: Maintenance Relay/,
        );
        assert.match(
          result.failures.join("\n"),
          /public\/production\.md contains forbidden runbook text: Tailscale SSH/,
        );
      },
    );
  });

  it("fails when a public runbook contract omits required structured fields", () => {
    withFixture(
      {
        "public/clean-base.md": [
          "```json clean-base-source-contract/v1",
          JSON.stringify(
            {
              schemaVersion: "clean-base-source-contract/v1",
              iso: {
                uriPrefix: "vm-host://factory/isos/",
              },
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [
            {
              path: "public/clean-base.md",
              scripts: [],
              requiredContracts: [
                {
                  schemaVersion: "clean-base-source-contract/v1",
                  requiredFields: {
                    "iso.fileNameEvidenceField": "source.iso.fileName",
                    "iso.sha256EvidenceField": "source.iso.sha256",
                    "iso.placeholderIdentityAllowed": false,
                  },
                },
              ],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/clean-base\.md required runbook contract clean-base-source-contract\/v1 field iso\.fileNameEvidenceField expected "source\.iso\.fileName"/,
        );
      },
    );
  });

  it("fails when a public runbook keeps an ISO placeholder as source identity", () => {
    withFixture(
      {
        "public/clean-base.md":
          "ISO source: `vm-host://factory/isos/<win10.iso>`",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [
            {
              path: "public/clean-base.md",
              scripts: [],
              forbiddenText: ["<win10.iso>"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/clean-base\.md contains forbidden runbook text: <win10\.iso>/,
        );
      },
    );
  });

  it("fails stale Tailscale service, CLI, identity, and SSH integration wording", () => {
    withFixture(
      {
        "public/runtime.md":
          "Install and validate the Tailscale service and CLI before using Tailscale SSH.",
        "scripts/testbed/runtime.mjs":
          "const tailscaleIp = run('tailscale status --json');",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/runtime.mjs",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["runtime acceptance"],
            },
          ],
          publicRunbooks: [
            {
              path: "public/runtime.md",
              scripts: ["scripts/testbed/runtime.mjs"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/runtime\.md:1 contains stale integration text/,
        );
        assert.match(
          result.failures.join("\n"),
          /scripts\/testbed\/runtime\.mjs:1 contains stale integration text/,
        );
      },
    );
  });

  it("rejects retired public contracts and runbooks even when they are not registered", () => {
    withFixture(
      {
        "public/vm-runtime-acceptance.md": "retired runbook",
        "public/legacy.md":
          "Run the static relay planner on the unraid host with iptables.",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /retired public runbook present: public\/vm-runtime-acceptance\.md/,
        );
        assert.match(
          result.failures.join("\n"),
          /public\/legacy\.md:1 contains retired public contract \(static relay planner\)/,
        );
        assert.match(
          result.failures.join("\n"),
          /public\/legacy\.md:1 contains retired public contract \(platform-specific host identity\)/,
        );
      },
    );
  });

  it("scans unregistered public documents for Tailscale compatibility text", () => {
    withFixture(
      {
        "public/legacy.md": "Use Tailscale SSH for emergency access.",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [],
          publicRunbooks: [],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /public\/legacy\.md:1 contains stale integration text/,
        );
      },
    );
  });

  it("allows clean-base Tailscale absent-by-default negative assertions", () => {
    withFixture(
      {
        "public/clean-base.md":
          "Tailscale service and CLI are absent by default and the image must not include Tailscale.",
        "scripts/windows/verify-factory-runtime.ps1":
          '$assertions.tailscaleDefaultAbsent = "Tailscale not_installed_by_default"',
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/windows/verify-factory-runtime.ps1",
              owner: "field-operations",
              category: "verifier-test guard",
              workflows: ["factory preparation"],
            },
          ],
          publicRunbooks: [
            {
              path: "public/clean-base.md",
              scripts: [],
            },
          ],
        });

        assert.doesNotMatch(
          result.failures.join("\n"),
          /stale integration text|non-negative Tailscale wording/,
        );
      },
    );
  });
});
