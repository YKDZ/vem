#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INVENTORY = [
  {
    path: "scripts/check-admin-api-contracts.mjs",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["admin api contract migration"],
  },
  {
    path: "scripts/check-admin-api-contracts.test.mjs",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["admin api contract migration"],
  },
  {
    path: "scripts/check-admin-contract-e2e-ci.mjs",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["admin api contract migration"],
  },
  {
    path: "scripts/check-admin-contract-e2e-ci.test.mjs",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["admin api contract migration"],
  },
  {
    path: "scripts/check-factory-runtime-prep.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/daemon-ipc-contracts/generate-contracts.ts",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["daemon ipc contract generation"],
  },
  {
    path: "scripts/daemon-ipc-contracts/generate-contracts.spec.ts",
    owner: "shared-contracts",
    category: "verifier-test guard",
    workflows: ["daemon ipc contract generation"],
  },
  {
    path: "scripts/check-machine-provisioning-default-api-base-url.mjs",
    owner: "machine-runtime",
    category: "explicitly maintained legacy operation",
    workflows: ["smoke"],
    verifier: "scripts/check-machine-provisioning-default-api-base-url.mjs",
  },
  {
    path: "scripts/check-machine-vision-deployment.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["managed update"],
  },
  {
    path: "scripts/check-managed-machine-update.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["managed update"],
  },
  {
    path: "scripts/check-repository-script-inventory.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: [
      "factory preparation",
      "runtime acceptance",
      "kiosk lockdown",
      "managed update",
      "smoke",
      "testbed workflows",
    ],
  },
  {
    path: "scripts/check-repository-script-inventory.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: [
      "factory preparation",
      "runtime acceptance",
      "kiosk lockdown",
      "managed update",
      "smoke",
      "testbed workflows",
    ],
  },
  {
    path: "scripts/check-windows-kiosk-lockdown.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["kiosk lockdown"],
  },
  {
    path: "scripts/testbed/win10-vem-e2e.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: [
      "factory preparation",
      "runtime acceptance",
      "testbed workflows",
    ],
  },
  {
    path: "scripts/testbed/win10-vem-e2e.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapters/libvirt-qcow2.unraid.json",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/apply-managed-update.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["managed update"],
  },
  {
    path: "scripts/windows/deploy-windows-artifact.sh",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["managed update"],
  },
  {
    path: "scripts/windows/machine-config.bringup.example.json",
    owner: "machine-runtime",
    category: "explicitly maintained legacy operation",
    workflows: ["smoke"],
    verifier: "scripts/check-machine-provisioning-default-api-base-url.mjs",
  },
  {
    path: "scripts/windows/prepare-factory-runtime.ps1",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/setup-scheduled-tasks.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation", "kiosk lockdown"],
  },
  {
    path: "scripts/windows/start-lower-controller-sim.ps1",
    owner: "machine-runtime",
    category: "explicitly maintained legacy operation",
    workflows: ["runtime acceptance", "testbed workflows"],
    runbook: "public/vm-runtime-acceptance.md",
  },
  {
    path: "scripts/windows/vending-daemon-smoke.ps1",
    owner: "machine-runtime",
    category: "explicitly maintained legacy operation",
    workflows: ["smoke"],
    verifier: "scripts/check-machine-provisioning-default-api-base-url.mjs",
  },
  {
    path: "scripts/windows/verify-factory-runtime.ps1",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/verify-kiosk-lockdown.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["kiosk lockdown"],
  },
  {
    path: "scripts/windows/verify-vem-runtime.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["runtime acceptance", "smoke", "managed update"],
  },
];

const DEFAULT_PUBLIC_RUNBOOKS = [
  {
    path: "public/clean-base-factory-acceptance.md",
    scripts: [
      "scripts/testbed/win10-vem-e2e.mjs",
      "scripts/windows/prepare-factory-runtime.ps1",
      "scripts/windows/verify-factory-runtime.ps1",
    ],
    forbiddenText: ["<win10.iso>"],
    requiredContracts: [
      {
        schemaVersion: "clean-base-source-contract/v1",
        requiredFields: {
          "iso.storageHost": "192.168.2.23",
          "iso.storageDirectory": "/mnt/user/isos",
          "iso.uriPrefix": "unraid://192.168.2.23/isos/",
          "iso.fileNameEvidenceField": "source.iso.fileName",
          "iso.sha256EvidenceField": "source.iso.sha256",
          "iso.uriEvidenceField": "source.iso.uri",
          "iso.fileNamePattern": "^[^/\\\\]+\\.iso$",
          "iso.sha256Pattern": "^[a-f0-9]{64}$",
          "iso.uriRule":
            "source.iso.uri == iso.uriPrefix + source.iso.fileName",
          "iso.placeholderIdentityAllowed": false,
          "canonicalVm.uri": "unraid://192.168.2.23/vms/win10-vem-clean-base",
          "canonicalVm.sourceEvidenceField": "source.uri",
          "cleanSnapshot.name": "vem-clean-base-before-factory-prep",
          "cleanSnapshot.uri": "snapshot:vem-clean-base-before-factory-prep",
          "cleanSnapshot.boundary": "pre-factory-preparation",
          "cleanSnapshot.evidenceField": "source.snapshot",
          "acceptanceEvidence.schemaVersion":
            "clean-base-factory-acceptance-report/v1",
          "acceptanceEvidence.kind": "clean-base-factory-acceptance",
          "dirtySourcePolicy.retainedStateTestbed": "dirty-host-evidence-only",
          "dirtySourcePolicy.localResetDoesNotPromoteCleanBase": true,
        },
        requiredIncludes: {
          sourceChain: [
            "approved-windows-10-iso",
            "canonical-clean-base-vm",
            "pre-factory-preparation-snapshot",
            "clean-base-factory-acceptance-report",
          ],
          allowedBeforeCleanSnapshot: [
            "windows-install-from-declared-iso",
            "temporary-administrator-access",
            "ssh-maintenance-reachability",
            "portrait-display-baseline",
            "temporary-network-setup",
            "clean-snapshot-creation",
          ],
          forbiddenBeforeCleanSnapshot: [
            "vem-runtime-installation",
            "machine-provisioning-claim",
            "production-identity-or-secrets",
            "inventory-product-payment-or-order-state",
            "unrecorded-windows-tuning",
          ],
        },
      },
    ],
  },
  {
    path: "public/vm-runtime-acceptance.md",
    scripts: [
      "scripts/testbed/win10-vem-e2e.mjs",
      "scripts/testbed/vm-host-adapter.mjs",
      "scripts/testbed/vm-host-adapters/libvirt-qcow2.unraid.json",
    ],
  },
  {
    path: "public/customer-accessible-kiosk-lockdown.md",
    scripts: [
      "scripts/windows/setup-scheduled-tasks.ps1",
      "scripts/windows/verify-kiosk-lockdown.ps1",
    ],
  },
  {
    path: "public/managed-machine-update.md",
    scripts: [
      "scripts/check-managed-machine-update.mjs",
      "scripts/check-machine-vision-deployment.mjs",
      "scripts/windows/apply-managed-update.ps1",
      "scripts/windows/deploy-windows-artifact.sh",
      "scripts/windows/setup-scheduled-tasks.ps1",
      "scripts/windows/verify-vem-runtime.ps1",
    ],
  },
];

const REQUIRED_CATEGORIES = new Set([
  "canonical entrypoint",
  "verifier-test guard",
  "public runbook operation",
  "explicitly maintained legacy operation",
]);

const REQUIRED_WORKFLOWS = [
  "factory preparation",
  "runtime acceptance",
  "kiosk lockdown",
  "managed update",
  "smoke",
  "testbed workflows",
];

function listFiles(root, directory) {
  const absoluteDirectory = join(root, directory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return files.sort();
}

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function pathExists(root, path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

function directoryExists(root, path) {
  try {
    return statSync(join(root, path)).isDirectory();
  } catch {
    return false;
  }
}

function validateInventoryEntry(entry) {
  const failures = [];
  if (!entry.owner) {
    failures.push(`${entry.path} missing owner`);
  }
  if (!REQUIRED_CATEGORIES.has(entry.category)) {
    failures.push(`${entry.path} has invalid category: ${entry.category}`);
  }
  if (!Array.isArray(entry.workflows) || entry.workflows.length === 0) {
    failures.push(`${entry.path} missing workflows`);
  }
  return failures;
}

function scriptMaintainsFactoryDeliveryEvidence(source) {
  return (
    source.includes("factory-runtime-manifest.json") &&
    source.includes("verify-factory-runtime") &&
    source.includes("factory-runtime-verification")
  );
}

function runbookReferencesScript(source, script) {
  const normalizedSource = source.replaceAll("\\", "/");
  const fileName = script.split("/").at(-1);
  const deployedWindowsPath = `C:/VEM/bringup/scripts/${fileName}`;
  return (
    source.includes(script) ||
    normalizedSource.includes(script) ||
    normalizedSource.includes(deployedWindowsPath)
  );
}

function legacyEvidenceReferences(entry) {
  return [
    entry.maintainedReference,
    entry.runbook,
    entry.packageScript,
    entry.acceptance,
    entry.verifier,
  ].filter(Boolean);
}

function validateLegacyEvidence(root, entry) {
  if (entry.category !== "explicitly maintained legacy operation") {
    return [];
  }
  const references = legacyEvidenceReferences(entry);
  if (references.length === 0) {
    return [
      `${entry.path} legacy operation missing maintainedReference or runbook/package/acceptance/verifier evidence`,
    ];
  }
  return references
    .filter((reference) => typeof reference === "string")
    .filter((reference) => reference.includes("/") || reference.includes("\\"))
    .filter((reference) => !pathExists(root, reference))
    .map((reference) => `${entry.path} legacy evidence missing: ${reference}`);
}

function isFactoryPreparationEntrypoint(entry) {
  return (
    entry.category === "canonical entrypoint" &&
    entry.workflows?.includes("factory preparation")
  );
}

function isRunbookFailure(failure) {
  return (
    failure.startsWith("public runbook") ||
    failure.includes(" references a script outside the inventory: ") ||
    failure.includes(" should reference ") ||
    failure.includes(" contains forbidden runbook text: ") ||
    failure.includes(" missing required runbook contract: ") ||
    failure.includes(" invalid required runbook contract ") ||
    failure.includes(" required runbook contract ")
  );
}

function getValueAtPath(object, path) {
  return path.split(".").reduce((value, segment) => {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    return value[segment];
  }, object);
}

function findJsonContract(text, schemaVersion) {
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fencePattern)) {
    const info = match[1].trim();
    if (!info.split(/\s+/).includes("json") && !info.includes(schemaVersion)) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(match[2]);
    } catch (error) {
      if (info.includes(schemaVersion)) {
        return { error };
      }
      continue;
    }
    if (parsed?.schemaVersion === schemaVersion) {
      return { contract: parsed };
    }
  }
  return {};
}

function validateRunbookContracts(runbook, text) {
  const failures = [];
  for (const forbiddenText of runbook.forbiddenText ?? []) {
    if (text.includes(forbiddenText)) {
      failures.push(
        `${runbook.path} contains forbidden runbook text: ${forbiddenText}`,
      );
    }
  }
  for (const requiredContract of runbook.requiredContracts ?? []) {
    const { contract, error } = findJsonContract(
      text,
      requiredContract.schemaVersion,
    );
    if (error) {
      failures.push(
        `${runbook.path} invalid required runbook contract ${requiredContract.schemaVersion}: ${error.message}`,
      );
      continue;
    }
    if (!contract) {
      failures.push(
        `${runbook.path} missing required runbook contract: ${requiredContract.schemaVersion}`,
      );
      continue;
    }

    for (const [fieldPath, expected] of Object.entries(
      requiredContract.requiredFields ?? {},
    )) {
      const actual = getValueAtPath(contract, fieldPath);
      if (actual !== expected) {
        failures.push(
          `${runbook.path} required runbook contract ${requiredContract.schemaVersion} field ${fieldPath} expected ${JSON.stringify(expected)}`,
        );
      }
    }

    for (const [fieldPath, expectedPattern] of Object.entries(
      requiredContract.requiredPatterns ?? {},
    )) {
      const actual = getValueAtPath(contract, fieldPath);
      const pattern = new RegExp(expectedPattern);
      if (typeof actual !== "string" || !pattern.test(actual)) {
        failures.push(
          `${runbook.path} required runbook contract ${requiredContract.schemaVersion} field ${fieldPath} should match ${expectedPattern}`,
        );
      }
    }

    for (const [fieldPath, requiredValues] of Object.entries(
      requiredContract.requiredIncludes ?? {},
    )) {
      const actual = getValueAtPath(contract, fieldPath);
      if (!Array.isArray(actual)) {
        failures.push(
          `${runbook.path} required runbook contract ${requiredContract.schemaVersion} field ${fieldPath} should be an array`,
        );
        continue;
      }
      for (const requiredValue of requiredValues) {
        if (!actual.includes(requiredValue)) {
          failures.push(
            `${runbook.path} required runbook contract ${requiredContract.schemaVersion} field ${fieldPath} missing ${requiredValue}`,
          );
        }
      }
    }
  }
  return failures;
}

export function checkRepositoryScriptInventory(options = {}) {
  const root = options.root ?? process.cwd();
  const inventory = options.inventory ?? DEFAULT_INVENTORY;
  const publicRunbooks = options.publicRunbooks ?? DEFAULT_PUBLIC_RUNBOOKS;
  const failures = [];
  const checks = [];

  const scripts = directoryExists(root, "scripts")
    ? listFiles(root, "scripts")
    : [];
  const entriesByPath = new Map(inventory.map((entry) => [entry.path, entry]));

  for (const entry of inventory) {
    for (const failure of validateInventoryEntry(entry)) {
      failures.push(failure);
    }
    if (!scripts.includes(entry.path)) {
      failures.push(`classified script missing from repository: ${entry.path}`);
      continue;
    }
    if (
      isFactoryPreparationEntrypoint(entry) &&
      !scriptMaintainsFactoryDeliveryEvidence(readText(root, entry.path))
    ) {
      failures.push(
        `image preparation shortcut bypasses factory delivery evidence: ${entry.path}`,
      );
    }
    for (const failure of validateLegacyEvidence(root, entry)) {
      failures.push(failure);
    }
  }

  for (const script of scripts) {
    if (!entriesByPath.has(script)) {
      failures.push(`unclassified script: ${script}`);
    }
  }

  const workflowCoverage = new Set(
    inventory.flatMap((entry) => entry.workflows ?? []),
  );
  for (const workflow of REQUIRED_WORKFLOWS) {
    if (!workflowCoverage.has(workflow)) {
      failures.push(`workflow missing inventory coverage: ${workflow}`);
    }
  }

  for (const runbook of publicRunbooks) {
    if (!pathExists(root, runbook.path)) {
      failures.push(`public runbook missing: ${runbook.path}`);
      continue;
    }
    const text = readText(root, runbook.path);
    for (const script of runbook.scripts) {
      if (!entriesByPath.has(script)) {
        failures.push(
          `${runbook.path} references a script outside the inventory: ${script}`,
        );
      }
      if (!runbookReferencesScript(text, script)) {
        failures.push(`${runbook.path} should reference ${script}`);
      }
    }
    failures.push(...validateRunbookContracts(runbook, text));
  }

  checks.push({
    name: "all-retained-scripts-classified",
    passed: !failures.some((failure) => failure.startsWith("unclassified")),
    detail: "every file under scripts/ has an owner and use category",
  });
  checks.push({
    name: "required-workflows-covered",
    passed: REQUIRED_WORKFLOWS.every((workflow) =>
      workflowCoverage.has(workflow),
    ),
    detail:
      "inventory covers factory preparation, runtime acceptance, kiosk lockdown, managed update, smoke, and testbed workflows",
  });
  checks.push({
    name: "public-runbooks-match-retained-scripts",
    passed: !failures.some(isRunbookFailure),
    detail: "public runbooks reference retained canonical operations",
  });
  checks.push({
    name: "factory-image-prep-retains-evidence-boundary",
    passed: !failures.some((failure) =>
      failure.startsWith("image preparation shortcut bypasses"),
    ),
    detail:
      "factory image preparation scripts keep manifest, verifier, and evidence output in the delivery path",
  });

  return { ok: failures.length === 0, checks, failures, inventory };
}

function printResult(result) {
  for (const check of result.checks) {
    const mark = check.passed ? "ok" : "not ok";
    console.log(`${mark} - ${check.name}: ${check.detail}`);
  }
  for (const failure of result.failures) {
    console.error(`not ok - ${failure}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlagIndex = process.argv.indexOf("--root");
  const root =
    rootFlagIndex === -1 ? process.cwd() : process.argv[rootFlagIndex + 1];
  const result = checkRepositoryScriptInventory({ root });
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
