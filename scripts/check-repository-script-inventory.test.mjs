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

function deliveryAssemblyFixture({ producerSource, executionSource }) {
  const member = "scripts/windows/vision-release-materialization.psm1";
  const producer = "scripts/factory/producer.mjs";
  const verifier = "scripts/factory/verifier.mjs";
  const executionTest = "scripts/factory/execution.mjs";
  return {
    files: {
      [member]: "Export-ModuleMember\n",
      [producer]: producerSource,
      [verifier]: [
        'import { createHash } from "node:crypto";',
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const contract = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));',
        'const bytes = readFileSync(join(contract.outputRoot, "stage", "member.bin"));',
        'const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;',
        'process.stdout.write(JSON.stringify({ nonce: contract.nonce, root: contract.root, files: { [contract.members[0]]: { stagedPath: "stage/member.bin", digest } } }) + "\\n");',
      ].join("\n"),
      [executionTest]: executionSource,
    },
    inventory: [
      {
        path: producer,
        owner: "field-operations",
        category: "public runbook operation",
        workflows: ["factory preparation"],
        deliveryAssemblyAction: "javascript-stage",
        deliveryAssembly: [member],
        deliveryAssemblyEvidence: {
          artifact: "stage/manifest.json",
          producer,
          verifier,
          executionTest,
          members: [member],
        },
      },
      {
        path: verifier,
        owner: "field-operations",
        category: "verifier-test guard",
        workflows: ["factory preparation"],
      },
      {
        path: executionTest,
        owner: "field-operations",
        category: "verifier-test guard",
        workflows: ["factory preparation"],
      },
      {
        path: member,
        owner: "field-operations",
        category: "public runbook operation",
        workflows: ["factory preparation"],
      },
    ],
  };
}

const WORKING_DELIVERY_PRODUCER = [
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const contract = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));',
  'mkdirSync(join(contract.outputRoot, "stage"), { recursive: true });',
  'writeFileSync(join(contract.outputRoot, "stage", "member.bin"), readFileSync(join(contract.repositoryRoot, contract.members[0])));',
  'writeFileSync(join(contract.outputRoot, "stage", "manifest.json"), JSON.stringify({ nonce: contract.nonce }));',
].join("\n");

const WORKING_DELIVERY_EXECUTION = [
  'import { spawnSync } from "node:child_process";',
  'import { readFileSync, writeFileSync } from "node:fs";',
  'import { createHash } from "node:crypto";',
  'import { join } from "node:path";',
  "const contractPath = process.argv.at(-1);",
  'const contract = JSON.parse(readFileSync(contractPath, "utf8"));',
  "for (const path of [contract.producer, contract.verifier]) {",
  '  const result = spawnSync(process.execPath, [join(contract.repositoryRoot, path), contractPath], { encoding: "utf8" });',
  "  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); process.exit(result.status ?? 1); }",
  "  if (path === contract.verifier) {",
  "    const artifact = readFileSync(join(contract.outputRoot, contract.artifact));",
  '    const artifactDigest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;',
  '    writeFileSync(join(contract.root, "execution-proof.json"), JSON.stringify({ schemaVersion: "vem-delivery-assembly-execution-proof/v1", nonce: contract.nonce, root: contract.root, producer: contract.producer, verifier: contract.verifier, artifact: { name: contract.artifact, stagedPath: contract.artifact, digest: artifactDigest }, verification: JSON.parse(result.stdout) }));',
  "  }",
  "}",
].join("\n");

describe("repository script inventory guard", () => {
  it("executes a nonce-bound producer and independently verified staged bytes", () => {
    const fixture = deliveryAssemblyFixture({
      producerSource: WORKING_DELIVERY_PRODUCER,
      executionSource: WORKING_DELIVERY_EXECUTION,
    });
    withFixture(fixture.files, (root) => {
      const result = checkRepositoryScriptInventory({
        root,
        inventory: fixture.inventory,
        publicRunbooks: [],
      });

      assert.equal(
        result.checks.find(
          (check) => check.name === "delivery-assembly-execution-contracts",
        )?.passed,
        true,
        result.failures.join("\n"),
      );
      assert.doesNotMatch(
        result.failures.join("\n"),
        /delivery assembly execution contract failed/,
      );
    });
  });

  for (const [name, producerSource, executionSource] of [
    [
      "an execution test that exits successfully without running anything",
      WORKING_DELIVERY_PRODUCER,
      "process.exit(0);",
    ],
    [
      "a dead producer with a complete declaration",
      "process.exit(0);",
      WORKING_DELIVERY_EXECUTION,
    ],
    [
      "a commented or template-only producer implementation",
      [
        "// writeFileSync(join(contract.root, 'stage', 'member.bin'), bytes);",
        "const template = `Copy-Item member.bin stage/member.bin`;",
        "const hereString = String.raw`@' Copy-Item member.bin stage/member.bin '@`;",
        "void template; void hereString;",
        "process.exit(0);",
      ].join("\n"),
      WORKING_DELIVERY_EXECUTION,
    ],
    [
      "an unused or shadowed producer implementation",
      [
        "function stageMember() { return 'would copy a member'; }",
        "const stageMember = () => 'shadowed';",
        "void stageMember;",
        "process.exit(0);",
      ].join("\n"),
      WORKING_DELIVERY_EXECUTION,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const fixture = deliveryAssemblyFixture({
        producerSource,
        executionSource,
      });
      withFixture(fixture.files, (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: fixture.inventory,
          publicRunbooks: [],
        });

        assert.equal(
          result.checks.find(
            (check) => check.name === "delivery-assembly-execution-contracts",
          )?.passed,
          false,
        );
        assert.match(
          result.failures.join("\n"),
          /deliveryAssembly execution contract failed/,
        );
      });
    });
  }

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
          /finalize\.mjs delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
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
          /experimental-vision-candidate\.mjs delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
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
          /win10-vem-e2e\.mjs delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
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
          /vision-release-install\.windows-harness\.ps1 delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
        );
      },
    );
  });

  it("fails when structured assembly evidence omits a classified materializer", () => {
    withFixture(
      {
        "scripts/factory/finalize.mjs":
          "dead source text is intentionally irrelevant",
        "scripts/factory/finalize.test.mjs": "test evidence",
        "scripts/windows/install-vision-release.ps1": "Write-Host install",
        "scripts/windows/vision-release-materialization.psm1":
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
              ],
              deliveryAssemblyEvidence: {
                artifact: "VEM/VISION-FACTORY-PROVISIONING.JSON",
                producer: "scripts/factory/finalize.mjs",
                verifier: "scripts/factory/finalize.test.mjs",
                executionTest: "scripts/factory/finalize.test.mjs",
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
