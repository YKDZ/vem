import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  ".github/workflows/factory-image-acceptance.yml",
  "utf8",
);
const factoryMedia = readFileSync(
  "scripts/factory/build-factory-media.mjs",
  "utf8",
);
const workflowDocument = parse(workflow);

function stepBlock(stepName) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe("Factory Image Acceptance workflow", () => {
  it("reads token files without requiring a trailing newline", () => {
    assert.doesNotMatch(workflow, /\bread\b[^\n]*token/);
    assert.equal(
      workflow.match(/token="\$\(<"\$automation_token"\)"/g)?.length,
      1,
    );
    assert.equal(
      workflow.match(/automation_token="\$\(<"\$automation_token_path"\)"/g)
        ?.length,
      1,
    );
  });

  it("requires the real platform-neutral Factory lifecycle orchestrator", () => {
    assert.match(
      workflow,
      /node scripts\/testbed\/factory-image-acceptance\.mjs/,
    );
    for (const input of [
      "VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID",
      "VEM_VM_HOST_ADAPTER",
      "VEM_VM_HOST_EVIDENCE_EXPORT_DIR",
      "VEM_FACTORY_UDF_EXTRACTOR_HOST_PATH",
      "VEM_FACTORY_UDF_WRITER_HOST_PATH",
      "VEM_FACTORY_WIMLIB_HOST_PATH",
      "VEM_FACTORY_WORK_ROOT",
      "VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY",
      "VEM_VM_HOST_EXPECTED_ADAPTER_SHA256",
    ])
      assert.match(workflow, new RegExp(input));
    assert.doesNotMatch(workflow, /VEM_FACTORY_PERSONALIZATION_RUN_ARGS_JSON/);
    assert.doesNotMatch(workflow, /post-claim-command-json/);
    assert.doesNotMatch(workflow, /win10-vem-e2e\.mjs/);
    assert.doesNotMatch(
      workflow,
      /legacy-provider|libvirt|qcow2|host filesystem path/i,
    );
  });

  it("allows a clean Windows installation to outlive the adapter client default", () => {
    assert.equal(
      workflowDocument.jobs.accept.env
        .VEM_FACTORY_CLEAN_INSTALL_ADAPTER_TIMEOUT_MS,
      "2700000",
    );
    assert.equal(
      workflowDocument.jobs.accept.env.VEM_VM_HOST_ADAPTER_TIMEOUT_MS,
      undefined,
    );
    const jobTimeoutMs =
      workflowDocument.jobs.accept["timeout-minutes"] * 60_000;
    const cleanInstallTimeoutMs = Number(
      workflowDocument.jobs.accept.env
        .VEM_FACTORY_CLEAN_INSTALL_ADAPTER_TIMEOUT_MS,
    );
    assert.ok(jobTimeoutMs - cleanInstallTimeoutMs >= 90 * 60_000);
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

  it("grants OIDC only to the Factory acceptance job that creates the relay session", () => {
    assert.match(
      workflow,
      /accept:\n(?:.*\n)*?\s+permissions:\n\s+contents: read\n\s+id-token: write/,
    );
    assert.doesNotMatch(
      workflow,
      /^permissions:\n\s+contents: read\n\s+id-token: write/m,
    );
    assert.match(workflow, /audience=vem-maintenance/);
    assert.match(workflow, /maintenance-automation\/exchange/);
  });

  it("pins the deployment-external VM Host Adapter by digest and lifecycle identity", () => {
    const guard = stepBlock("Guard Exact Protected Runner Before Checkout");
    const lifecycle = stepBlock("Run Typed Factory Lifecycle");

    assert.match(guard, /VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY/);
    assert.match(guard, /VEM_VM_HOST_EXPECTED_ADAPTER_SHA256/);
    assert.match(guard, /sha256sum "\$VEM_VM_HOST_ADAPTER"/);
    assert.match(
      guard,
      /test "\$observed_adapter_sha256" = "\$VEM_VM_HOST_EXPECTED_ADAPTER_SHA256"/,
    );
    assert.match(
      guard,
      /\^vm-host-adapter:\/\/\[A-Za-z0-9\._\/-\]\+@\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/,
    );
    assert.match(lifecycle, /VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY/);
    assert.match(lifecycle, /lifecycle\.reports/);
    assert.match(lifecycle, /value\.adapter/);
    assert.match(lifecycle, /Factory VM Host Adapter identity mismatch/);
    assert.doesNotMatch(workflow, /\bunraid\b/i);
    assert.doesNotMatch(workflow, /unraid:\/\//i);
  });

  it("creates run-scoped SSH key material and requests the certificate from the same automation session", () => {
    const exchange = stepBlock("Create Maintenance Relay Session");
    const input = stepBlock("Generate Typed Factory Lifecycle Input");
    const cleanup = stepBlock("Cleanup Ephemeral Services");

    assert.doesNotMatch(workflow, /VEM_FACTORY_ACCEPTANCE_SSH_/);
    assert.match(
      exchange,
      /ssh_dir="\$RUNNER_TEMP\/vem-factory-maintenance-ssh-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.match(
      exchange,
      /ssh-keygen -q -t ed25519 -N '' -f "\$ssh_key_path"/,
    );
    assert.match(exchange, /maintenance-automation\/session\/ssh-certificate/);
    assert.match(exchange, /VEM_FACTORY_MAINTENANCE_SSH_IDENTITY_PATH/);
    assert.match(exchange, /VEM_FACTORY_MAINTENANCE_SSH_CERTIFICATE_PATH/);
    assert.match(
      input,
      /sshIdentityPath\.startsWith\(process\.env\.RUNNER_TEMP \+ "\/vem-factory-maintenance-ssh-"\)/,
    );
    assert.match(
      input,
      /identityPath: sshIdentityPath,\n\s+certificatePath: sshCertificatePath/,
    );
    assert.match(cleanup, /maintenance-automation\/session\/revoke/);
    assert.match(cleanup, /revoked\.status !== "revoked"/);
    assert.match(
      cleanup,
      /rm -f "\$automation_token_path" "\$revoke_response_path"/,
    );
    assert.match(cleanup, /rm -rf -- "\$ssh_directory"/);
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
      "MAINTENANCE_CONTROL_PLANE_URL",
      "MAINTENANCE_ALLOW_INSECURE_HTTP",
      "MAINTENANCE_RUNNER_PEER_ID",
      "MAINTENANCE_TARGET_MACHINE_ID",
      "VEM_MAINTENANCE_RELAY_INTERFACE",
      "MAINTENANCE_RELAY_PEER_ID",
      "MAINTENANCE_RELAY_ENDPOINT",
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
    const lifecycle = stepBlock("Run Typed Factory Lifecycle");
    assert.match(
      lifecycle,
      /export VEM_FACTORY_EPHEMERAL_DATABASE_URL="\$DATABASE_URL"/,
    );
    assert.match(lifecycle, /unset VEM_FACTORY_EPHEMERAL_DATABASE_URL/);
    assert.doesNotMatch(
      stepBlock("Generate Typed Factory Lifecycle Input"),
      /databaseUrl|database_url|VEM_FACTORY_EPHEMERAL_DATABASE_URL/,
    );
    assert.match(workflow, /SERVICE_HOST: "0\.0\.0\.0"/);
    assert.match(workflow, /-p 18884:1883/);
    assert.doesNotMatch(workflow, /192\.168\.2\.23/);
    assert.match(workflow, /Create Maintenance Relay Session/);
    assert.match(workflow, /Prove Relay WireGuard Bootstrap Route/);
    assert.match(workflow, /maintenance-automation\/exchange/);
    assert.match(workflow, /maintenance-automation\/session/);
    assert.match(workflow, /factory-maintenance-relay-attestation\.mjs/);
    assert.doesNotMatch(workflow, /VEM_FACTORY_MAINTENANCE_RELAY_SESSION_JSON/);
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
    assert.match(workflow, /MACHINE_PROVISIONING_PROFILE: testbed/);
    assert.doesNotMatch(workflow, /550e8400-e29b-41d4-a716-446655440010/);
    assert.doesNotMatch(
      workflow,
      /AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=/,
    );
    assert.doesNotMatch(
      workflow,
      /MAINTENANCE_RELAY_ENDPOINT: 127\.0\.0\.1:51820/,
    );
    assert.equal(
      workflowDocument.jobs.accept.env.MAINTENANCE_RELAY_ENDPOINT,
      "${{ vars.VEM_MAINTENANCE_RELAY_ENDPOINT }}",
    );
    const guard = stepBlock("Guard Exact Protected Runner Before Checkout");
    assert.match(guard, /MAINTENANCE_RELAY_ENDPOINT/);
    assert.match(guard, /BASH_REMATCH\[2\]/);
    assert.match(guard, /<= 65535/);
    assert.doesNotMatch(workflow, /session\.relay\.endpoint/);
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
    assert.match(
      workflow,
      /controlPlaneSession = JSON\.parse\(fs\.readFileSync\(process\.env\.VEM_FACTORY_MAINTENANCE_SESSION_PATH/,
    );
    assert.doesNotMatch(workflow, /VEM_FACTORY_MAINTENANCE_RELAY_SESSION_JSON/);
    assert.match(workflow, /maintenanceRelaySession,/);
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

  it("uses runner-host Factory tools for admission, not builder-container paths", () => {
    assert.match(
      workflow,
      /udfExtractorPath: process\.env\.VEM_FACTORY_UDF_EXTRACTOR_HOST_PATH/,
    );
    assert.match(
      workflow,
      /udfWriterPath: process\.env\.VEM_FACTORY_UDF_WRITER_HOST_PATH/,
    );
    assert.match(
      workflow,
      /wimlibPath: process\.env\.VEM_FACTORY_WIMLIB_HOST_PATH/,
    );
    assert.doesNotMatch(workflow, /LD_LIBRARY_PATH/);
    assert.doesNotMatch(
      workflow,
      /udfExtractorPath: process\.env\.VEM_FACTORY_UDF_EXTRACTOR_CONTAINER_PATH/,
    );
  });

  it("keeps large admission extraction off system temporary storage", () => {
    assert.match(
      workflow,
      /admission_tmp="\$VEM_FACTORY_WORK_ROOT\/acceptance-tmp\/\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.match(workflow, /export TMPDIR="\$admission_tmp"/);
    assert.match(
      workflow,
      /if \[\[ "\$VEM_FACTORY_WORK_ROOT" = \/\* && "\$VEM_FACTORY_WORK_ROOT" != \/ \]\]; then/,
    );
    assert.match(
      workflow,
      /admission_tmp="\$VEM_FACTORY_WORK_ROOT\/acceptance-tmp\/\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.equal([...factoryMedia.matchAll(/TMPDIR: tmpdir\(\)/g)].length, 4);
    assert.doesNotMatch(workflow, /export TMPDIR="\$RUNNER_TEMP/);
  });

  it("uploads only the dedicated sanitized evidence directory", () => {
    assert.match(
      workflow,
      /if: \$\{\{ always\(\) && env\.VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH != '' \}\}/,
    );
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
