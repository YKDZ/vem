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
                uriPrefix: "unraid://192.168.2.23/isos/",
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
          "ISO source: `unraid://192.168.2.23/isos/<win10.iso>`",
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
