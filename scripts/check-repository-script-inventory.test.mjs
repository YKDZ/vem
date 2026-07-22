import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkRepositoryScriptInventory,
  DEFAULT_INVENTORY,
} from "./check-repository-script-inventory.mjs";

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
  const member = "scripts/testbed/artifact-output.psm1";
  const producer = "scripts/testbed/prod.mjs";
  const verifier = "scripts/testbed/prod.test.mjs";
  const executionTest = "scripts/testbed/prod.exec.mjs";
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
        'process.stdout.write(JSON.stringify({ nonce: contract.nonce, root: contract.root, files: { [contract.members[0]]: { stagedPath: "stage/member.bin", digest } }) + "\\n");',
      ].join("\n"),
      [executionTest]: executionSource,
    },
    inventory: [
      {
        path: producer,
        owner: "field-operations",
        category: "operator operation",
        workflows: ["runtime acceptance"],
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
        workflows: ["runtime acceptance"],
      },
      {
        path: executionTest,
        owner: "field-operations",
        category: "verifier-test guard",
        workflows: ["runtime acceptance"],
      },
      {
        path: member,
        owner: "field-operations",
        category: "operator operation",
        workflows: ["runtime acceptance"],
      },
    ],
  };
}

describe("repository script inventory guard", () => {
  it("classifies the runtime business-check registry", () => {
    assert.deepEqual(
      DEFAULT_INVENTORY.find(
        (entry) => entry.path === "scripts/testbed/business-check-registry.mjs",
      ),
      {
        path: "scripts/testbed/business-check-registry.mjs",
        owner: "field-operations",
        category: "test support operation",
        workflows: ["runtime acceptance", "testbed workflows"],
      },
    );
  });

  it("classifies the unattended payment-provider runner and its guard", () => {
    for (const [path, category] of [
      [
        "scripts/testbed/payment-provider-guest-full.mjs",
        "test support operation",
      ],
      [
        "scripts/testbed/payment-provider-guest-full.test.mjs",
        "verifier-test guard",
      ],
    ]) {
      assert.deepEqual(
        DEFAULT_INVENTORY.find((entry) => entry.path === path),
        {
          path,
          owner: "field-operations",
          category,
          workflows: ["runtime acceptance", "testbed workflows"],
        },
      );
    }
  });

  it("classifies delivery metadata without executing assembly logic", () => {
    const fixture = deliveryAssemblyFixture({
      producerSource: 'throw new Error("must remain dormant");',
      executionSource: 'throw new Error("must remain dormant");',
    });

    withFixture(fixture.files, (root) => {
      const result = checkRepositoryScriptInventory({
        root,
        inventory: fixture.inventory,
      });

      assert.equal(
        result.checks.find(
          (check) => check.name === "delivery-assembly-static-classification",
        )?.passed,
        true,
        result.failures.join("\n"),
      );
      assert.doesNotMatch(
        result.failures.join("\n"),
        /deliveryAssembly execution contract failed/,
      );
    });
  });

  it("fails when a retained script is not classified", () => {
    withFixture(
      {
        "scripts/testbed/retired-gate.ps1": "Write-Host keep",
        "scripts/testbed/unclassified-shortcut.ps1": "Write-Host shortcut",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/retired-gate.ps1",
              owner: "field-operations",
              category: "canonical entrypoint",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /unclassified script: scripts\/testbed\/unclassified-shortcut\.ps1/,
        );
      },
    );
  });

  it("rejects a closure that has no structured verifier evidence", () => {
    withFixture(
      {
        "scripts/testbed/test-candidate.ps1":
          'Import-Module (Join-Path $PSScriptRoot "artifact-output.psm1")',
        "scripts/testbed/artifact-output.psm1": "Export-ModuleMember",
        "scripts/testbed/diagnostic.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/test-candidate.ps1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
              deliveryClosure: [
                "scripts/testbed/artifact-output.psm1",
                "scripts/testbed/diagnostic.psm1",
              ],
            },
            {
              path: "scripts/testbed/artifact-output.psm1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/diagnostic.psm1",
              owner: "field-operations",
              category: "test support operation",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /test-candidate\.ps1 delivery closure must declare a classified verifier and exact members/,
        );
      },
    );
  });

  it("does not let a commented PowerShell import satisfy structured closure evidence", () => {
    withFixture(
      {
        "scripts/testbed/test-candidate.ps1":
          '# Import-Module (Join-Path $PSScriptRoot "artifact-output.psm1")',
        "scripts/testbed/artifact-output.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/test-candidate.ps1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
              deliveryClosure: ["scripts/testbed/artifact-output.psm1"],
            },
            {
              path: "scripts/testbed/artifact-output.psm1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /test-candidate\.ps1 delivery closure must declare a classified verifier and exact members/,
        );
      },
    );
  });

  it("rejects a JavaScript source-shaped producer without machine-readable evidence", () => {
    withFixture(
      {
        "scripts/testbed/finalize.mjs":
          'for (const script of ["member-a.ps1", "artifact-output.psm1"]) { stage(`ARTIFACTS/${script}`); }',
        "scripts/testbed/member-a.ps1": "Write-Host install",
        "scripts/testbed/artifact-output.psm1": "Export-ModuleMember",
        "scripts/testbed/redacted.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/finalize.mjs",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/testbed/member-a.ps1",
                "scripts/testbed/artifact-output.psm1",
                "scripts/testbed/redacted.psm1",
              ],
            },
            {
              path: "scripts/testbed/member-a.ps1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/artifact-output.psm1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/redacted.psm1",
              owner: "field-operations",
              category: "test support operation",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /finalize\.mjs delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
        );
      },
    );
  });

  it("rejects dead JavaScript file list without delivery evidence", () => {
    withFixture(
      {
        "scripts/testbed/experimental.mjs": [
          'const installers = ["member-a.ps1", "artifact-output.psm1"];',
          "// stage every installer",
        ].join("\n"),
        "scripts/testbed/member-a.ps1": "Write-Host install",
        "scripts/testbed/artifact-output.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/experimental.mjs",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/testbed/member-a.ps1",
                "scripts/testbed/artifact-output.psm1",
              ],
            },
            {
              path: "scripts/testbed/member-a.ps1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/artifact-output.psm1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /experimental\.mjs delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact/,
        );
      },
    );
  });

  it("rejects assembly without classified verifier and execution test", () => {
    withFixture(
      {
        "scripts/testbed/finalize.mjs": "dead source text",
        "scripts/testbed/finalize.test.mjs": "test evidence",
        "scripts/testbed/member-a.ps1": "Write-Host install",
        "scripts/testbed/artifact-output.psm1": "Export-ModuleMember",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/finalize.mjs",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
              deliveryAssemblyAction: "javascript-stage",
              deliveryAssembly: [
                "scripts/testbed/member-a.ps1",
                "scripts/testbed/artifact-output.psm1",
              ],
              deliveryAssemblyEvidence: {
                artifact: "VEM/TARGET-ARTIFACTS.json",
                producer: "scripts/testbed/finalize.mjs",
                verifier: "scripts/testbed/finalize.test.mjs",
                executionTest: "scripts/testbed/finalize.test.mjs",
                members: ["scripts/testbed/member-a.ps1"],
              },
            },
            {
              path: "scripts/testbed/finalize.test.mjs",
              owner: "field-operations",
              category: "verifier-test guard",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/member-a.ps1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
            {
              path: "scripts/testbed/artifact-output.psm1",
              owner: "field-operations",
              category: "operator operation",
              workflows: ["runtime acceptance"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /finalize\.mjs delivery assembly evidence omits classified member: scripts\/testbed\/artifact-output\.psm1/,
        );
      },
    );
  });

  it("requires evidence for explicitly maintained legacy operations", () => {
    withFixture(
      {
        "scripts/testbed/legacy-shortcut.ps1": "Write-Host legacy",
      },
      (root) => {
        const result = checkRepositoryScriptInventory({
          root,
          inventory: [
            {
              path: "scripts/testbed/legacy-shortcut.ps1",
              owner: "machine-runtime",
              category: "explicitly maintained legacy operation",
              workflows: ["smoke"],
            },
          ],
        });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /scripts\/testbed\/legacy-shortcut\.ps1 legacy operation missing maintainedReference or package\/acceptance\/verifier evidence/,
        );
      },
    );
  });
});
