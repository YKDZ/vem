#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_INVENTORY = [
  ...[
    "delayed-pickup-native-audio-guest-full.mjs",
    "daemon-ready-refresh.mjs",
    "business-check-registry.mjs",
    "commissioning-acceptance.mjs",
    "full-workflow-fixtures.mjs",
    "full-workflow-evidence-manifest.mjs",
    "full-workflow-orchestrator.mjs",
    "full-workflow-stability-gate.mjs",
    "full-workflow-validator.mjs",
    "hardware-lifecycle-guest-full.mjs",
    "installed-ipc-recovery-guest-full.mjs",
    "installed-system-touch-keyboard.mjs",
    "environment-control-guest-full.mjs",
    "mock-payment-create-gate.mjs",
    "payment-provider-guest-full.mjs",
    "payment-recovery-guest-full.mjs",
    "local-operations-guest-full.mjs",
    "scanner-payment-code-guest-full.mjs",
    "serial-fulfillment-error-guest-full.mjs",
    "track-handoff-recovery.mjs",
    "vision-try-on-acceptance.mjs",
  ].map((path) => ({
    path: `scripts/testbed/${path}`,
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  })),
  ...[
    "ensure-testbed-pwsh.test.mjs",
    "business-check-registry.test.mjs",
    "commissioning-acceptance.test.mjs",
    "daemon-ready-refresh.test.mjs",
    "environment-control-guest-full.test.mjs",
    "full-workflow-evidence-manifest.test.mjs",
    "full-workflow-fixtures.test.mjs",
    "full-workflow-orchestrator.test.mjs",
    "full-workflow-validator.test.mjs",
    "payment-provider-guest-full.test.mjs",
    "payment-recovery-guest-full.test.mjs",
    "local-operations-guest-full.test.mjs",
    "installed-system-touch-keyboard.test.mjs",
    "run-full-vision-try-on-track.test.mjs",
    "scanner-payment-code-guest-full.test.mjs",
    "serial-fulfillment-error-guest-full.test.mjs",
    "track-handoff-recovery.test.mjs",
    "vision-try-on-acceptance.test.mjs",
  ].map((path) => ({
    path: `scripts/testbed/${path}`,
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  })),
  ...["ensure-testbed-pwsh.ps1", "run-full-vision-try-on-track.ps1"].map(
    (path) => ({
      path: `scripts/testbed/${path}`,
      owner: "field-operations",
      category: "test support operation",
      workflows: ["runtime acceptance", "testbed workflows"],
    }),
  ),
  {
    path: "scripts/testbed/fixtures/local-testbed-catalog.json",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/local-testbed.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/local-testbed-host.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/local-testbed-host.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/local-testbed.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/runtime-testbed-orchestrator.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/runtime-testbed-trigger.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/runtime-testbed-orchestrator.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/installed-runtime-smoke.mjs",
    owner: "machine-runtime-console",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/installed-runtime-smoke.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/run-local-testbed-guest.ps1",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/machine-ui-cdp-driver.mjs",
    owner: "machine-runtime-console",
    category: "test support operation",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/machine-ui-cdp-driver.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/machine-ui-screenshot-scenarios.mjs",
    owner: "machine-runtime-console",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/machine-ui-screenshot-scenarios.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/host-serial-control-plane.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/host-serial-control-plane.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/qemu-usb-serial-host-adapter.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/qemu-usb-serial-host-adapter.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/fast-route-stress-sale.mjs",
    owner: "machine-runtime-console",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/fast-route-stress-sale.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/installed-kiosk-sale-acceptance.mjs",
    owner: "machine-runtime-console",
    category: "test support operation",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/installed-kiosk-sale-acceptance.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/publish-backend-images.mjs",
    owner: "backend-operations",
    category: "canonical entrypoint",
    workflows: ["backend deployment"],
  },
  {
    path: "scripts/deploy-backend-stack.mjs",
    owner: "backend-operations",
    category: "canonical entrypoint",
    workflows: ["backend deployment"],
  },
  {
    path: "scripts/backend-image-deployment.test.mjs",
    owner: "backend-operations",
    category: "verifier-test guard",
    workflows: ["backend deployment"],
  },
  {
    path: "scripts/check-machine-customer-payment-copy.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/check-machine-customer-payment-copy.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/security/platform-private-key-scanner.mjs",
    owner: "platform-security",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
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
    path: "scripts/check-effective-config-hard-migration.mjs",
    owner: "machine-runtime",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/check-effective-config-hard-migration.test.mjs",
    owner: "machine-runtime",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/fixtures/architecture-guard/negative-effective-config/legacy-path.txt",
    owner: "machine-runtime",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/check-ci-workflow-needs.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["smoke", "testbed workflows"],
  },
  {
    path: "scripts/check-static-quality-workflow.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["smoke", "testbed workflows"],
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
    path: "scripts/check-repository-script-inventory.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: [
      "runtime acceptance",
      "runtime acceptance",
      "smoke",
      "testbed workflows",
    ],
  },
  {
    path: "scripts/check-repository-script-inventory.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: [
      "runtime acceptance",
      "runtime acceptance",
      "smoke",
      "testbed workflows",
    ],
  },
  {
    path: "scripts/testbed/win10-vem-e2e.mjs",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance"],
  },
  {
    path: "scripts/testbed/validate-vm-runtime-acceptance-inputs.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter-contract.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter-contract.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/default-audio-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/default-audio-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/display-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/display-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/windows-native-audio-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/windows-native-audio-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-native-audio-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-native-audio-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-native-audio-acceptance.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-native-audio-acceptance.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-live-production-track.mjs",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "Issue16 full-mode control plane"],
  },
  {
    path: "scripts/testbed/delayed-pickup-live-production-track.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "Issue16 full-mode control plane"],
  },
  {
    path: "scripts/testbed/delayed-pickup-machine-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-daemon-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-platform-evidence.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/delayed-pickup-production-producers.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/sale-audio-capture-host-adapter.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/sale-audio-capture-host-adapter.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/fake-vm-host-adapter.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter-serial-conformance.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/run-vm-host-adapter.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/run-vm-host-adapter.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/build-win10-baseline.mjs",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/kvm-baseline.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/libvirt-runtime-profile.mjs",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/linux-kvm-baseline.mjs",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/prepare-vm-runtime.ps1",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/shared-guest-preparation.ps1",
    owner: "field-operations",
    category: "test support operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/kvm-baseline/verify-vm-runtime.ps1",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/vision-main-artifacts.psm1",
    owner: "field-operations",
    category: "operator operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/get-vision-main-artifacts.ps1",
    owner: "field-operations",
    category: "operator operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/install-vision-main-artifact.ps1",
    owner: "field-operations",
    category: "operator operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/vision-main-consumer.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/vision-main-consumer.windows-harness.ps1",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/runtime-artifact-descriptor.mjs",
    owner: "machine-runtime",
    category: "operator operation",
    workflows: ["runtime acceptance", "smoke"],
  },
  {
    path: "scripts/windows/runtime-bootstrap.example.json",
    owner: "machine-runtime",
    category: "operator operation",
    workflows: ["smoke"],
  },
  {
    path: "scripts/windows/start-lower-controller-sim.ps1",
    owner: "machine-runtime",
    category: "test support operation",
    workflows: ["testbed workflows"],
  },
  {
    path: "scripts/windows/vending-daemon-smoke.ps1",
    owner: "machine-runtime",
    category: "explicitly maintained legacy operation",
    workflows: ["smoke"],
    verifier: "scripts/check-machine-provisioning-default-api-base-url.mjs",
  },
  {
    path: "scripts/windows/verify-vem-runtime.ps1",
    owner: "field-operations",
    category: "operator operation",
    workflows: ["runtime acceptance", "smoke"],
  },
];

const REQUIRED_CATEGORIES = new Set([
  "canonical entrypoint",
  "verifier-test guard",
  "operator operation",
  "explicitly maintained legacy operation",
  "test support operation",
]);

const REQUIRED_WORKFLOWS = ["runtime acceptance", "smoke", "testbed workflows"];

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

function validateDeliveryClosure(entry, entriesByPath) {
  if (entry.deliveryClosure === undefined) return [];
  if (
    !Array.isArray(entry.deliveryClosure) ||
    entry.deliveryClosure.length === 0
  ) {
    return [
      `${entry.path} deliveryClosure must name one or more closure members`,
    ];
  }
  const evidence = entry.deliveryClosureEvidence;
  if (
    !evidence ||
    typeof evidence.verifier !== "string" ||
    !entriesByPath.has(evidence.verifier) ||
    entriesByPath.get(evidence.verifier).category !== "verifier-test guard" ||
    !Array.isArray(evidence.members)
  ) {
    return [
      `${entry.path} delivery closure must declare a classified verifier and exact members`,
    ];
  }
  const failures = [];
  const declaredMembers = new Set(evidence.members);
  for (const closurePath of entry.deliveryClosure) {
    if (typeof closurePath !== "string" || !entriesByPath.has(closurePath)) {
      failures.push(
        `${entry.path} delivery closure is not classified: ${String(closurePath)}`,
      );
      continue;
    }
    if (!declaredMembers.has(closurePath)) {
      failures.push(
        `${entry.path} delivery closure evidence omits classified member: ${closurePath}`,
      );
    }
  }
  for (const member of declaredMembers) {
    if (!entry.deliveryClosure.includes(member)) {
      failures.push(
        `${entry.path} delivery closure evidence names an undeclared member: ${member}`,
      );
    }
  }
  return failures;
}

const DELIVERY_ASSEMBLY_ACTIONS = new Set([
  "javascript-stage",
  "javascript-upload",
  "powershell-copy",
]);

function validateDeliveryAssembly(entry, entriesByPath) {
  if (entry.deliveryAssembly === undefined) return [];
  if (
    !Array.isArray(entry.deliveryAssembly) ||
    entry.deliveryAssembly.length === 0
  ) {
    return [
      `${entry.path} deliveryAssembly must name one or more assembled members`,
    ];
  }
  if (!DELIVERY_ASSEMBLY_ACTIONS.has(entry.deliveryAssemblyAction)) {
    return [
      `${entry.path} deliveryAssembly must declare a supported deliveryAssemblyAction`,
    ];
  }
  const evidence = entry.deliveryAssemblyEvidence;
  if (
    !evidence ||
    typeof evidence.artifact !== "string" ||
    evidence.artifact.length === 0 ||
    evidence.producer !== entry.path ||
    typeof evidence.verifier !== "string" ||
    !entriesByPath.has(evidence.verifier) ||
    entriesByPath.get(evidence.verifier).category !== "verifier-test guard" ||
    typeof evidence.executionTest !== "string" ||
    !entriesByPath.has(evidence.executionTest) ||
    entriesByPath.get(evidence.executionTest).category !==
      "verifier-test guard" ||
    !Array.isArray(evidence.members)
  ) {
    return [
      `${entry.path} delivery assembly must bind its executable producer, classified verifier, execution test, and evidence artifact`,
    ];
  }
  const failures = [];
  const declaredMembers = new Set(evidence.members);
  for (const assemblyPath of entry.deliveryAssembly) {
    if (typeof assemblyPath !== "string" || !entriesByPath.has(assemblyPath)) {
      failures.push(
        `${entry.path} delivery assembly member is not classified: ${String(assemblyPath)}`,
      );
      continue;
    }
    if (!declaredMembers.has(assemblyPath)) {
      failures.push(
        `${entry.path} delivery assembly evidence omits classified member: ${assemblyPath}`,
      );
    }
  }
  for (const member of declaredMembers) {
    if (!entry.deliveryAssembly.includes(member)) {
      failures.push(
        `${entry.path} delivery assembly evidence names an undeclared member: ${member}`,
      );
    }
  }
  return failures;
}

function validatePreapprovalDeliveryAssembly(entry, entriesByPath) {
  if (entry.preapprovalDeliveryAssembly === undefined) return [];
  const evidence = entry.preapprovalDeliveryAssembly;
  if (
    !evidence ||
    typeof evidence.artifact !== "string" ||
    evidence.artifact.length === 0 ||
    evidence.producer !== entry.path ||
    typeof evidence.verifier !== "string" ||
    !entriesByPath.has(evidence.verifier) ||
    entriesByPath.get(evidence.verifier).category !== "verifier-test guard" ||
    typeof evidence.executionTest !== "string" ||
    !entriesByPath.has(evidence.executionTest) ||
    entriesByPath.get(evidence.executionTest).category !==
      "verifier-test guard" ||
    !Array.isArray(evidence.members) ||
    evidence.members.length === 0
  ) {
    return [
      `${entry.path} preapproval delivery assembly must declare a classified verifier and VEM preapproval evidence artifact`,
    ];
  }
  const failures = [];
  for (const member of evidence.members) {
    if (typeof member !== "string" || !entriesByPath.has(member)) {
      failures.push(
        `${entry.path} preapproval delivery assembly member is not classified: ${String(member)}`,
      );
    }
  }
  return failures;
}

function legacyEvidenceReferences(entry) {
  return [
    entry.maintainedReference,
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
      `${entry.path} legacy operation missing maintainedReference or package/acceptance/verifier evidence`,
    ];
  }
  return references
    .filter((reference) => typeof reference === "string")
    .filter((reference) => reference.includes("/") || reference.includes("\\"))
    .filter((reference) => !pathExists(root, reference))
    .map((reference) => `${entry.path} legacy evidence missing: ${reference}`);
}

export function checkRepositoryScriptInventory(options = {}) {
  const root = options.root ?? process.cwd();
  const inventory = options.inventory ?? DEFAULT_INVENTORY;
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
    failures.push(...validateDeliveryClosure(entry, entriesByPath));
    const assemblyFailures = validateDeliveryAssembly(entry, entriesByPath);
    const preapprovalAssemblyFailures = validatePreapprovalDeliveryAssembly(
      entry,
      entriesByPath,
    );
    failures.push(...assemblyFailures, ...preapprovalAssemblyFailures);
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
    detail: "inventory covers runtime acceptance, smoke, and testbed workflows",
  });
  checks.push({
    name: "delivery-assembly-static-classification",
    passed: !failures.some((failure) => failure.includes("delivery assembly")),
    detail:
      "delivery producers, verifiers, and contract drivers are classified without execution",
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
