#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INVENTORY = [
  ...[
    "delayed-pickup-native-audio-guest-full.mjs",
    "daemon-ready-refresh.mjs",
    "full-workflow-fixtures.mjs",
    "full-workflow-evidence-manifest.mjs",
    "full-workflow-orchestrator.mjs",
    "full-workflow-stability-gate.mjs",
    "full-workflow-validator.mjs",
    "installed-ipc-recovery-guest-full.mjs",
    "installed-system-touch-keyboard.mjs",
    "mock-payment-create-gate.mjs",
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
    "daemon-ready-refresh.test.mjs",
    "full-workflow-evidence-manifest.test.mjs",
    "full-workflow-fixtures.test.mjs",
    "full-workflow-orchestrator.test.mjs",
    "full-workflow-validator.test.mjs",
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
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/installed-kiosk-sale-acceptance.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
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
    path: "scripts/factory/payment-secret-boundary.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "managed update"],
  },
  {
    path: "scripts/security/platform-private-key-scanner.mjs",
    owner: "platform-security",
    category: "verifier-test guard",
    workflows: ["factory preparation", "managed update"],
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
    path: "scripts/check-machine-e2e-ci.test.mjs",
    owner: "machine-runtime-console",
    category: "verifier-test guard",
    workflows: ["runtime acceptance"],
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
    path: "scripts/check-factory-runtime-prep.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/check-factory-manifest.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/check-factory-image-acceptance-workflow.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/build-factory-media.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/build-factory-media.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/oobe-registry.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/Dockerfile",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-builder-definition.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/content-addressed-store.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/content-addressed-store.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-cli.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-cli.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-acceptance-admission.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-manifest.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-manifest.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/vision-release.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "managed update"],
  },
  {
    path: "scripts/factory/vision-release.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "managed update"],
  },
  {
    path: "scripts/factory/experimental-vision-candidate.mjs",
    owner: "field-operations",
    category: "explicitly maintained legacy operation",
    workflows: ["factory preparation"],
    verifier: "scripts/windows/vision-main-consumer.test.mjs",
  },
  {
    path: "scripts/factory/experimental-vision-candidate.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "managed update"],
  },
  {
    path: "scripts/factory/verify-vision-delivery-assembly.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "runtime acceptance", "managed update"],
  },
  {
    path: "scripts/factory/run-vision-delivery-assembly-contract.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "runtime acceptance", "managed update"],
  },
  {
    path: "scripts/factory/factory-personalization-media.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/factory-personalization-media.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/import-runtime-artifacts.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/import-runtime-artifacts.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/runtime-artifact-descriptor.mjs",
    owner: "machine-runtime",
    category: "public runbook operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/factory/sanitize-build-evidence.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/sanitize-build-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/verify-asset-evidence.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/verify-asset-evidence.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/factory/verify-real-windows-source.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/check-windows-factory-maintenance.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/check-ci-workflow-needs.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["smoke", "testbed workflows"],
  },
  {
    path: "scripts/check-windows-bringup-bundle.mjs",
    owner: "machine-runtime",
    category: "verifier-test guard",
    workflows: ["smoke", "testbed workflows"],
  },
  {
    path: "scripts/check-windows-bringup-bundle.test.mjs",
    owner: "machine-runtime",
    category: "verifier-test guard",
    workflows: ["smoke", "testbed workflows"],
  },
  {
    path: "scripts/check-windows-oobe-registry.test.mjs",
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
    path: "scripts/check-maintenance-relay-runbook.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/check-maintenance-ssh-ca-secrets.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "service deployment"],
  },
  {
    path: "scripts/check-github-oidc-automation-workflow.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/check-vm-runtime-acceptance-workflow.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
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
    category: "explicitly maintained legacy operation",
    verifier: "scripts/testbed/win10-vem-e2e.test.mjs",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/factory-image-acceptance.mjs",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/factory-image-acceptance.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/factory-maintenance-relay-attestation.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/factory-maintenance-relay-attestation.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/testbed/win10-vem-e2e.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
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
    path: "scripts/testbed/vm-host-adapter-conformance.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/testbed/vm-host-adapter-conformance.test.mjs",
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
    path: "scripts/check-active-runtime-factory-retirement.test.mjs",
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
    path: "scripts/windows/apply-managed-update.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["managed update"],
  },
  {
    path: "scripts/windows/vision-main-artifacts.psm1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/get-vision-main-artifacts.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["runtime acceptance", "testbed workflows"],
  },
  {
    path: "scripts/windows/install-vision-main-artifact.ps1",
    owner: "field-operations",
    category: "public runbook operation",
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
    path: "scripts/windows/payment-secret-guard.test.mjs",
    owner: "platform-security",
    category: "verifier-test guard",
    workflows: ["factory preparation", "managed update"],
  },
  {
    path: "scripts/windows/verify-progressive-delivery.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "runtime acceptance", "managed update"],
  },
  {
    path: "scripts/windows/verify-progressive-delivery.test.mjs",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation", "runtime acceptance", "managed update"],
  },
  {
    path: "scripts/windows/runtime-bootstrap.example.json",
    owner: "machine-runtime",
    category: "public runbook operation",
    workflows: ["smoke"],
  },
  {
    path: "scripts/windows/prepare-factory-runtime.ps1",
    owner: "field-operations",
    category: "canonical entrypoint",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/factory-maintenance-fixtures/clean-state-evidence.json",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/setup-scheduled-tasks.ps1",
    owner: "field-operations",
    category: "public runbook operation",
    workflows: ["factory preparation", "kiosk lockdown"],
  },
  {
    path: "scripts/windows/test-factory-maintenance-fixtures.ps1",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["factory preparation"],
  },
  {
    path: "scripts/windows/test-wireguard-localsystem-acceptance.ps1",
    owner: "field-operations",
    category: "verifier-test guard",
    workflows: ["runtime acceptance", "testbed workflows"],
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
    path: "public/windows-bringup-bundle.md",
    scripts: [],
    requiredText: ["Runtime Bootstrap", "certificate-only SSH"],
  },
  {
    path: "public/managed-machine-update.md",
    scripts: [],
  },
  {
    path: "public/unified-field-delivery.md",
    scripts: [],
  },
];

const REQUIRED_CATEGORIES = new Set([
  "canonical entrypoint",
  "verifier-test guard",
  "public runbook operation",
  "explicitly maintained legacy operation",
  "test support operation",
]);

const RETIRED_PUBLIC_RUNBOOKS = [
  "public/clean-base-factory-acceptance.md",
  "public/vm-runtime-acceptance.md",
];

const STALE_PUBLIC_CONTRACT_PATTERNS = [
  { pattern: /\bunraid\b/i, label: "platform-specific host identity" },
  { pattern: /\blibvirt\b/i, label: "platform-specific VM adapter" },
  { pattern: /\bqcow2\b/i, label: "platform-specific disk format" },
  { pattern: /\/mnt\/user\b/i, label: "host filesystem path" },
  { pattern: /unraid:\/\//i, label: "platform-specific source URI" },
  { pattern: /\biptables\b/i, label: "iptables renderer" },
  { pattern: /maintenance-relay:plan/i, label: "static relay command" },
  { pattern: /\bsshpass\b|\bSSHPASS\b/, label: "password SSH helper" },
];

const REQUIRED_WORKFLOWS = [
  "factory preparation",
  "runtime acceptance",
  "kiosk lockdown",
  "managed update",
  "smoke",
  "testbed workflows",
];

const STALE_INTEGRATION_TEXT_EXEMPT_PATHS = new Set([
  "scripts/check-repository-script-inventory.mjs",
  "scripts/check-repository-script-inventory.test.mjs",
]);

const ACCEPTED_MAINTENANCE_ARCHITECTURE_CATEGORIES = new Set([
  "canonical entrypoint",
  "public runbook operation",
  "explicitly maintained legacy operation",
]);

const RETIRED_MAINTENANCE_ARCHITECTURE_PATTERNS = [
  {
    pattern: /\bVEM_TESTBED_WINDOWS_PASSWORD\b/,
    label: "Windows testbed password secret",
  },
  {
    pattern: /\bstatic\s+(?:Service API\s+)?relay\s+plan(?:ner)?\b/i,
    label: "static relay planner",
  },
  {
    pattern:
      /\b(?:online(?:\s+(?:package|Windows\s+Capability))?|(?:Windows\s+)?Capability)\s+(?:installation\s+)?fallback\b/i,
    label: "online or capability fallback",
  },
  {
    pattern:
      /\bfallback\s+to\s+(?:an?\s+)?(?:online(?:\s+(?:package|Windows\s+Capability))?|(?:Windows\s+)?Capability)\b/i,
    label: "online or capability fallback",
  },
  {
    pattern:
      /\b(?:mock|TCP)\b[^\n]{0,120}\bproduction\s+(?:evidence|acceptance)\b/i,
    label: "mock or TCP production evidence",
  },
  {
    pattern:
      /\bproduction\s+(?:evidence|acceptance)\b[^\n]{0,120}\b(?:mock|TCP)\b/i,
    label: "mock or TCP production evidence",
  },
  { pattern: /\btransport-neutral\b/i, label: "transport-neutral ingress" },
  {
    pattern: /\btemporary[-\s]network\b|现场临时网络/u,
    label: "temporary network ingress",
  },
  {
    pattern:
      /\b(?:alternative|alternate|dedicated)\s+(?:maintenance\s+)?tunnel\b|(?:替代|专用)隧道/iu,
    label: "alternative tunnel ingress",
  },
  { pattern: /\bpassword\s+SSH\b/i, label: "password SSH" },
  {
    pattern: /\bemergency\s+deployment\b|紧急部署/iu,
    label: "emergency deployment compatibility path",
  },
];

const NEGATIVE_MAINTENANCE_ARCHITECTURE_CONTEXT =
  /\b(?:no|not|never|must\s+not|do\s+not|does\s+not|without|disabled?|reject(?:ed|s|ing)?|removed|forbidden|hard-fail(?:s|ed)?|not\s+accepted|negative\s+test\s+fixture)\b/i;

function isAcceptedMaintenanceArchitectureWorkflow(entry) {
  return ACCEPTED_MAINTENANCE_ARCHITECTURE_CATEGORIES.has(entry.category);
}

function isAllowedMaintenanceArchitectureNegativeContext(path, lines, index) {
  const line = lines[index];
  if (
    /(?:\.test\.[cm]?[jt]s$|\/fixtures?\/)/.test(path) &&
    /\b(?:negative\s+test|fixture)\b/i.test(line)
  ) {
    return true;
  }
  if (NEGATIVE_MAINTENANCE_ARCHITECTURE_CONTEXT.test(line)) {
    return true;
  }
  const wrappedNegativeContext = lines
    .slice(Math.max(0, index - 1), index + 1)
    .join(" ");
  if (NEGATIVE_MAINTENANCE_ARCHITECTURE_CONTEXT.test(wrappedNegativeContext)) {
    return true;
  }
  const removalListContext = lines
    .slice(Math.max(0, index - 12), index)
    .join(" ");
  return /requires deleting, not retaining, superseded paths/i.test(
    removalListContext,
  );
}

function validateRetiredMaintenanceArchitectureText(path, text) {
  const failures = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (isAllowedMaintenanceArchitectureNegativeContext(path, lines, index)) {
      continue;
    }
    for (const rule of RETIRED_MAINTENANCE_ARCHITECTURE_PATTERNS.filter(
      (candidate) => candidate.pattern.test(line),
    )) {
      failures.push(
        `${path}:${index + 1} contains retired maintenance architecture (${rule.label}): ${line.trim()}`,
      );
    }
  }
  return failures;
}

const STALE_TAILSCALE_INTEGRATION_PATTERNS = [
  {
    pattern: /\btailscale\s+(?:ip|status|ssh)\b/i,
    label: "Tailscale CLI identity/status command",
  },
  {
    pattern: /\bGet-CommandEvidence\s+["']tailscale["']/i,
    label: "Tailscale CLI evidence",
  },
  {
    pattern: /\bGet-ServiceStateOrNull\s+-Name\s+["']Tailscale["']/i,
    label: "Tailscale service evidence",
  },
  {
    pattern: /expected-testbed-tailscale-ip/i,
    label: "testbed tailnet IP expectation",
  },
  {
    pattern: /\btailscale(?:Name|Ips?|Ip)\b/,
    label: "Tailscale identity evidence field",
  },
  {
    pattern: /Tailscale SSH/i,
    label: "Tailscale SSH wording",
  },
  {
    pattern: /Tailscale-backed/i,
    label: "Tailscale-backed transport wording",
  },
  {
    pattern: /Tailscale identity/i,
    label: "Tailscale identity wording",
  },
  {
    pattern: /tailnet\s+IP\s+evidence/i,
    label: "tailnet IP evidence wording",
  },
  {
    pattern:
      /\b(?:install|require|validate|verify|ensure|enable)\w*\b.*\bTailscale\b.*\b(?:service|CLI|command|identity|SSH)\b/i,
    label: "Tailscale service/CLI requirement wording",
  },
];

const ALLOWED_TAILSCALE_NEGATIVE_BASELINE_PATTERN =
  /\b(absent|absence|not[_ -]?installed|not_installed_by_default|not\s+install|not\s+include|must\s+not\s+include|without\s+installing|does\s+not\s+include|avoid\s+Tailscale|no\s+Tailscale|doesNotMatch)\b|!\s*\w+\.includes/i;

function isAllowedTailscaleNegativeBaseline(line) {
  return (
    /\bTailscale\b/i.test(line) &&
    ALLOWED_TAILSCALE_NEGATIVE_BASELINE_PATTERN.test(line)
  );
}

function validateStaleIntegrationText(path, text) {
  if (STALE_INTEGRATION_TEXT_EXEMPT_PATHS.has(path)) {
    return [];
  }
  const failures = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const stalePattern = STALE_TAILSCALE_INTEGRATION_PATTERNS.find((rule) =>
      rule.pattern.test(line),
    );
    if (stalePattern && !isAllowedTailscaleNegativeBaseline(line)) {
      failures.push(
        `${path}:${index + 1} contains stale integration text (${stalePattern.label}): ${line.trim()}`,
      );
      continue;
    }
    if (
      path.startsWith("public/") &&
      /\b(?:Tailscale|tailnet)\b/i.test(line) &&
      !isAllowedTailscaleNegativeBaseline(line)
    ) {
      failures.push(
        `${path}:${index + 1} contains non-negative Tailscale wording: ${line.trim()}`,
      );
    }
  }
  return failures;
}

function validateStalePublicContractText(path, text) {
  const failures = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const stalePattern of STALE_PUBLIC_CONTRACT_PATTERNS.filter((rule) =>
      rule.pattern.test(line),
    )) {
      failures.push(
        `${path}:${index + 1} contains retired public contract (${stalePattern.label}): ${line.trim()}`,
      );
    }
  }
  return failures;
}

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
    failure.includes(" contains stale integration text ") ||
    failure.includes(" contains non-negative Tailscale wording") ||
    failure.includes(" contains retired public contract ") ||
    failure.includes(" contains retired maintenance architecture ") ||
    failure.startsWith("retired public runbook present") ||
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
  for (const requiredText of runbook.requiredText ?? []) {
    if (!text.includes(requiredText)) {
      failures.push(
        `${runbook.path} missing required runbook text: ${requiredText}`,
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
    failures.push(
      ...validateStaleIntegrationText(entry.path, readText(root, entry.path)),
    );
    failures.push(...validateDeliveryClosure(entry, entriesByPath));
    const assemblyFailures = validateDeliveryAssembly(entry, entriesByPath);
    const preapprovalAssemblyFailures = validatePreapprovalDeliveryAssembly(
      entry,
      entriesByPath,
    );
    failures.push(...assemblyFailures, ...preapprovalAssemblyFailures);
    if (isAcceptedMaintenanceArchitectureWorkflow(entry)) {
      failures.push(
        ...validateRetiredMaintenanceArchitectureText(
          entry.path,
          readText(root, entry.path),
        ),
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
    failures.push(...validateStaleIntegrationText(runbook.path, text));
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

  for (const retiredRunbook of RETIRED_PUBLIC_RUNBOOKS) {
    if (pathExists(root, retiredRunbook)) {
      failures.push(`retired public runbook present: ${retiredRunbook}`);
    }
  }

  if (directoryExists(root, "public")) {
    for (const path of listFiles(root, "public")) {
      if (!path.endsWith(".md")) continue;
      const text = readText(root, path);
      failures.push(...validateStaleIntegrationText(path, text));
      failures.push(...validateStalePublicContractText(path, text));
      failures.push(...validateRetiredMaintenanceArchitectureText(path, text));
    }
  }

  if (directoryExists(root, ".github/workflows")) {
    for (const path of listFiles(root, ".github/workflows")) {
      if (!path.endsWith(".yml") && !path.endsWith(".yaml")) continue;
      failures.push(
        ...validateRetiredMaintenanceArchitectureText(
          path,
          readText(root, path),
        ),
      );
    }
  }

  checks.push({
    name: "all-retained-scripts-classified",
    passed: !failures.some((failure) => failure.startsWith("unclassified")),
    detail: "every file under scripts/ has an owner and use category",
  });
  checks.push({
    name: "retired-public-runbooks-absent",
    passed: !failures.some((failure) =>
      failure.startsWith("retired public runbook present"),
    ),
    detail:
      "superseded platform-specific public runbooks cannot re-enter the repository",
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
