import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  ".github/workflows/factory-image-acceptance.yml",
  "utf8",
);

describe("Factory Image Acceptance workflow", () => {
  it("requires the real platform-neutral Factory lifecycle orchestrator", () => {
    assert.match(
      workflow,
      /node scripts\/testbed\/factory-image-acceptance\.mjs/,
    );
    for (const input of [
      "VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID",
      "VEM_VM_HOST_ADAPTER",
      "VEM_VM_HOST_EVIDENCE_EXPORT_DIR",
    ])
      assert.match(workflow, new RegExp(input));
    assert.doesNotMatch(workflow, /VEM_FACTORY_PERSONALIZATION_RUN_ARGS_JSON/);
    assert.doesNotMatch(workflow, /post-claim-command-json/);
    assert.doesNotMatch(workflow, /win10-vem-e2e\.mjs/);
    assert.doesNotMatch(workflow, /unraid|libvirt|qcow2|\/mnt\/user/i);
  });

  it("provides a runner-owned evidence export directory before lifecycle capture", () => {
    assert.doesNotMatch(
      workflow,
      /VEM_VM_HOST_EVIDENCE_EXPORT_DIR: \$\{\{ runner\.temp \}\}/,
    );
    assert.match(
      workflow,
      /VEM_VM_HOST_EVIDENCE_EXPORT_DIR="\$RUNNER_TEMP\/vem-factory-host-evidence/,
    );
    assert.match(workflow, /VEM_VM_HOST_EVIDENCE_EXPORT_DIR=%s.*GITHUB_ENV/);
    const lifecycleStart = workflow.indexOf(
      "- name: Run Typed Factory Lifecycle",
    );
    const lifecycle = workflow.slice(lifecycleStart);
    assert.match(lifecycle, /mkdir -p "\$VEM_VM_HOST_EVIDENCE_EXPORT_DIR"/);
  });

  it("starts a same-run ephemeral platform and writes the typed lifecycle input at runtime", () => {
    for (const required of [
      "Start Ephemeral Postgres And MQTT",
      "Build And Start Service API",
      "testbed:prepare-ephemeral-platform",
      "Generate Typed Factory Lifecycle Input",
      "DATABASE_URL",
      "EPHEMERAL_API_READY_URL",
      "VEM_FACTORY_PLATFORM_INGRESS_HOST",
      "MAINTENANCE_RELAY_PEER_ID",
      "MAINTENANCE_RELAY_PUBLIC_KEY",
      "MAINTENANCE_RELAY_TUNNEL_ADDRESS",
      "Cleanup Ephemeral Services",
    ]) {
      assert.match(workflow, new RegExp(required));
    }
    assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
    assert.match(workflow, /factory-image-acceptance-input\.json/);
    assert.match(
      workflow,
      /--api-base-url\s+"http:\/\/\$\{VEM_FACTORY_PLATFORM_INGRESS_HOST\}:26850\/api"/,
    );
    assert.match(
      workflow,
      /--mqtt-url\s+"mqtt:\/\/\$\{VEM_FACTORY_PLATFORM_INGRESS_HOST\}:18884"/,
    );
    assert.match(workflow, /curl -fsS "\$EPHEMERAL_API_READY_URL\/health"/);
    assert.match(workflow, /SERVICE_HOST: "0\.0\.0\.0"/);
    assert.match(workflow, /-p 18884:1883/);
    assert.doesNotMatch(workflow, /192\.168\.2\.23/);
    assert.doesNotMatch(workflow, /MAINTENANCE_CONTROL_PLANE_URL/);
  });

  it("writes ephemeral platform evidence through an absolute workspace path", () => {
    assert.match(
      workflow,
      /evidence_root="\$GITHUB_WORKSPACE\/artifacts\/factory-image-acceptance\/lifecycle\/\$RUN_ID"/,
    );
    assert.match(
      workflow,
      /--output "\$evidence_root\/ephemeral-platform\.json"/,
    );
    assert.match(
      workflow,
      /VEM_FACTORY_EPHEMERAL_PLATFORM_EVIDENCE=%s.*"\$evidence_root\/ephemeral-platform\.json"/,
    );
    assert.doesNotMatch(workflow, /"\$GITHUB_WORKSPACE\/\$evidence_root/);
  });

  it("shares every required testbed maintenance setting with the Service API and preparer", () => {
    for (const [name, value] of [
      ["MACHINE_PROVISIONING_PROFILE", "testbed"],
      ["MAINTENANCE_RELAY_PEER_ID", "550e8400-e29b-41d4-a716-446655440010"],
      ["MAINTENANCE_RELAY_ENDPOINT", "127.0.0.1:51820"],
      [
        "MAINTENANCE_RELAY_PUBLIC_KEY",
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      ],
      ["MAINTENANCE_RELAY_TUNNEL_ADDRESS", "10.91.0.1"],
    ]) {
      assert.match(workflow, new RegExp(`${name}: ${value}`));
    }
    assert.match(
      workflow,
      /--maintenance-relay-peer-id\s+"\$MAINTENANCE_RELAY_PEER_ID"/,
    );
    assert.match(
      workflow,
      /--maintenance-relay-public-key\s+"\$MAINTENANCE_RELAY_PUBLIC_KEY"/,
    );
    assert.match(
      workflow,
      /--maintenance-relay-tunnel-address\s+"\$MAINTENANCE_RELAY_TUNNEL_ADDRESS"/,
    );
  });

  it("separates runner-local Service API MQTT from machine-facing endpoints", () => {
    const start = workflow.indexOf("- name: Build And Start Service API");
    const nextStep = workflow.indexOf("\n      - name:", start + 1);
    const serviceApiStart = workflow.slice(start, nextStep);

    assert.match(
      serviceApiStart,
      /MQTT_URL: \$\{\{ env\.EPHEMERAL_MQTT_LOCAL_URL \}\}/,
    );
    assert.match(
      serviceApiStart,
      /MACHINE_MQTT_URL: \$\{\{ format\('mqtt:\/\/\{0\}:18884', vars\.VEM_FACTORY_PLATFORM_INGRESS_HOST\) \}\}/,
    );
    assert.match(
      serviceApiStart,
      /MACHINE_API_BASE_URL: \$\{\{ format\('http:\/\/\{0\}:26850\/api', vars\.VEM_FACTORY_PLATFORM_INGRESS_HOST\) \}\}/,
    );
    assert.doesNotMatch(
      serviceApiStart,
      /MACHINE_API_BASE_URL: http:\/\/localhost/,
    );
    assert.doesNotMatch(
      serviceApiStart,
      /\$\{VEM_FACTORY_PLATFORM_INGRESS_HOST\}/,
    );
    assert.match(
      workflow,
      /--mqtt-url\s+"mqtt:\/\/\$\{VEM_FACTORY_PLATFORM_INGRESS_HOST\}:18884"/,
    );
  });

  it("consumes the Factory ISO from CAS and pins protected artifact upload", () => {
    assert.match(workflow, /VEM_FACTORY_ASSET_STORE/);
    assert.match(
      workflow,
      /path\.join\(process\.env\.VEM_FACTORY_ASSET_STORE, "sha256"/,
    );
    assert.match(
      workflow,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.doesNotMatch(workflow, /actions\/upload-artifact@v4/);
  });

  it("uploads only the dedicated sanitized evidence directory", () => {
    assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
    assert.match(workflow, /actions\/upload-artifact@/);
    assert.match(
      workflow,
      /artifacts\/factory-image-acceptance\/sanitized-upload\/\*\*/,
    );
    assert.doesNotMatch(
      workflow,
      /path:\s*\|\s*\n\s*artifacts\/factory-image-acceptance\/lifecycle/,
    );
  });

  it("uses adapter cleanup-only mode instead of legacy SSH staging cleanup", () => {
    assert.match(workflow, /--cleanup-only/);
    assert.doesNotMatch(workflow, /--cleanup-factory-staging/);
  });

  it("only finalizes an adapter lifecycle after typed input exists", () => {
    const start = workflow.indexOf(
      "- name: Independently Finalize Adapter Lifecycle",
    );
    const end = workflow.indexOf("\n      - name:", start + 1);
    const finalizer = workflow.slice(start, end);

    assert.match(
      finalizer,
      /if \[\[ -n "\$\{VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH:-\}" && -f "\$VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH" \]\]; then/,
    );
    assert.match(finalizer, /--cleanup-only/);
  });

  it("fails cleanup when the Service API process or ephemeral containers remain", () => {
    const cleanupStart = workflow.indexOf("- name: Cleanup Ephemeral Services");
    const cleanup = workflow.slice(cleanupStart);
    assert.doesNotMatch(cleanup, /set \+e/);
    assert.match(cleanup, /kill -0/);
    assert.match(cleanup, /docker inspect/);
    assert.match(cleanup, /exit "\$failed"/);
  });
});
