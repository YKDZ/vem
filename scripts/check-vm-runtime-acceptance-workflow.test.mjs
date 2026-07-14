import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflowPath = ".github/workflows/vm-runtime-acceptance.yml";

function readWorkflow() {
  assert.equal(existsSync(workflowPath), true, `${workflowPath} should exist`);
  return readFileSync(workflowPath, "utf8");
}

function requiredTextPattern(text) {
  return new RegExp(
    text
      .split(" ")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

function stepBlock(workflow, stepName) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe("VM runtime acceptance workflow maintenance relay path", () => {
  it("checks out the dispatched commit before using repository validation code", () => {
    const workflow = readWorkflow();
    const checkout = stepBlock(workflow, "Checkout Trusted Commit");
    const guard = stepBlock(workflow, "Guard Protected Maintenance Trust Boundary");

    assert.ok(
      workflow.indexOf("- name: Checkout Trusted Commit") <
        workflow.indexOf("- name: Guard Protected Maintenance Trust Boundary"),
      "checkout must happen before the repository validation script",
    );
    assert.match(checkout, /ref:\s*\$\{\{ github\.sha \}\}/);
    assert.match(checkout, /persist-credentials:\s*false/);
    assert.match(guard, /git rev-parse HEAD/);
    assert.match(
      guard,
      /node scripts\/testbed\/validate-vm-runtime-acceptance-inputs\.mjs/,
    );
  });

  it("downloads Windows runtime artifacts with bounded curl retries on the self-hosted runner", () => {
    const workflow = readWorkflow();
    const download = stepBlock(workflow, "Download Windows Runtime Artifacts");

    assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read/);
    assert.doesNotMatch(download, /uses:\s+actions\/download-artifact@v4/);
    assert.match(download, /timeout-minutes:\s+25/);
    assert.match(download, /ARTIFACT_NAME:/);
    assert.match(
      download,
      /\$\{GITHUB_API_URL\}\/repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}\/artifacts/,
    );
    assert.match(download, /--max-time 120/);
    assert.match(download, /--max-time 1200/);
    assert.match(download, /--retry 3/);
    assert.match(download, /archive_download_url/);
    assert.match(download, /VEM_RUNTIME_ARTIFACT_CACHE_DIR/);
    assert.match(download, /RUNNER_TOOL_CACHE/);
    assert.match(download, /cache_key=/);
    assert.match(download, /unzip -tq "\$cache_zip"/);
    assert.match(download, /Using cached Windows runtime artifact zip/);
    assert.match(download, /cp "\$artifact_zip" "\$cache_zip"/);
    assert.match(
      download,
      /unzip -q "\$artifact_zip" -d artifacts\/vm-runtime-inputs/,
    );
  });

  it("starts ephemeral infrastructure with explicit Postgres and MQTT readiness diagnostics", () => {
    const workflow = readWorkflow();
    const ephemeralServices = stepBlock(
      workflow,
      "Start Ephemeral Postgres And MQTT",
    );

    assert.match(ephemeralServices, /postgres_name=/);
    assert.match(ephemeralServices, /mqtt_name=/);
    assert.match(
      ephemeralServices,
      /docker inspect -f '\{\{\.State\.Status\}\}'/,
    );
    assert.match(ephemeralServices, /wait_for_tcp\(\)/);
    assert.match(ephemeralServices, /wait_for_tcp 127\.0\.0\.1 55432/);
    assert.match(ephemeralServices, /Postgres did not become ready/);
    assert.match(ephemeralServices, /wait_for_tcp 127\.0\.0\.1 18883/);
    assert.match(ephemeralServices, /MQTT did not become ready/);
    assert.doesNotMatch(ephemeralServices, /docker exec/);
    assert.doesNotMatch(ephemeralServices, /\n\s*exit 0\n/);
  });

  it("starts service-api on the same port used by the workflow health check", () => {
    const workflow = readWorkflow();
    const serviceApi = stepBlock(workflow, "Build And Start Service API");

    assert.match(
      serviceApi,
      /curl --globoff -fsS http:\/\/127\.0\.0\.1:26849\/api\/health/,
    );
    assert.match(serviceApi, /SERVICE_PORT:\s+"26849"/);
    assert.doesNotMatch(serviceApi, /\n\s+PORT:\s+"26849"/);
  });

  it("starts runner WireGuard before a platform-neutral adapter request and consumes only its discovered guest endpoint", () => {
    const workflow = readWorkflow();

    for (const requiredText of [
      "VEM_MAINTENANCE_RELAY_INTERFACE",
      "VEM_MAINTENANCE_RELAY_RUNNER_PEER_IP",
      "Start Runner Maintenance Relay WireGuard Peer",
      "command -v wg-quick",
      "sudo wg-quick up",
      "root-owned runner WireGuard config",
      "--maintenance-ingress-source-allowlist",
      "maintenance-relay-diagnostics.txt",
      "maintenance-automation/session/ssh-certificate",
    ]) {
      assert.match(workflow, requiredTextPattern(requiredText));
    }

    const wireGuardStepIndex = workflow.indexOf(
      "Start Runner Maintenance Relay WireGuard Peer",
    );
    const restoreStepIndex = workflow.indexOf("Restore Windows Runtime VM");
    assert.ok(wireGuardStepIndex > 0, "workflow should start WireGuard");
    assert.ok(
      wireGuardStepIndex < restoreStepIndex,
      "runner WireGuard startup must happen before VM restore SSH readiness",
    );

    const restoreBlock = workflow.slice(
      restoreStepIndex,
      workflow.indexOf("- name: Run VM Runtime Acceptance"),
    );
    assert.match(
      restoreBlock,
      /node scripts\/testbed\/run-vm-host-adapter\.mjs/,
    );
    assert.match(restoreBlock, /test -n "\$\{VEM_VM_HOST_ADAPTER:-\}"/);
    assert.match(restoreBlock, /--target-identity\s+"\$VEM_VM_HOST_TARGET_ID"/);
    assert.match(
      restoreBlock,
      /--approved-runtime-base\s+"\$VEM_VM_HOST_APPROVED_BASE_ID"/,
    );
    assert.doesNotMatch(restoreBlock, /scripts\/testbed\/vm-host-adapter\.mjs/);
    assert.doesNotMatch(
      restoreBlock,
      /--adapter|--target-vm|--base-image|--overlay-disk/,
    );

    for (const forbidden of [
      /inputs\.(?:base_image|overlay_disk|target_vm)/,
      /\/mnt\/user|unraid:\/\/|qcow2|libvirt/i,
      /VEM_VM_HOST_ADAPTER:\s*\$\{\{/,
    ]) {
      assert.doesNotMatch(workflow, forbidden);
    }

    const endpoint = stepBlock(
      workflow,
      "Consume Discovered Guest Maintenance Endpoint",
    );
    assert.match(endpoint, /vm-host-adapter-report\.json/);
    assert.match(endpoint, /endpoint\.reachability !== "discovered"/);
    assert.match(endpoint, /VM_GUEST_MAINTENANCE_HOST=\$\{endpoint\.host\}/);
    assert.match(endpoint, /VM_GUEST_MAINTENANCE_PORT=\$\{endpoint\.port\}/);

    const acceptanceBlock = workflow.slice(
      workflow.indexOf("- name: Run VM Runtime Acceptance"),
      workflow.indexOf("- name: Upload VM Runtime Acceptance Artifacts"),
    );
    assert.match(
      acceptanceBlock,
      /--remote\s+"\$WINDOWS_SSH_USER@\$VM_GUEST_MAINTENANCE_HOST"/,
    );
    assert.match(
      acceptanceBlock,
      /--maintenance-ingress-source-allowlist\s+"\$VEM_MAINTENANCE_RELAY_RUNNER_PEER_IP"/,
    );
    assert.match(acceptanceBlock, /--ssh-port\s+"\$VM_GUEST_MAINTENANCE_PORT"/);
    assert.match(
      acceptanceBlock,
      /--identity\s+"\$MAINTENANCE_SSH_DIR\/id_ed25519"/,
    );
    assert.match(
      acceptanceBlock,
      /--certificate\s+"\$MAINTENANCE_SSH_DIR\/id_ed25519-cert\.pub"/,
    );
    assert.doesNotMatch(acceptanceBlock, /sshpass|SSHPASS/);
    assert.doesNotMatch(acceptanceBlock, /MAINTENANCE_RELAY_WINDOWS_SSH_HOST/);
    assert.doesNotMatch(workflow, /vm_wireguard_ip/);
    assert.doesNotMatch(workflow, /VEM_MAINTENANCE_RELAY_RUNNER_WG_CONFIG/);
    assert.doesNotMatch(workflow, /runner_wireguard_(?:peer_ip|interface)/);
    const conformance = stepBlock(workflow, "Run Host Adapter Conformance");
    assert.match(
      conformance,
      /node scripts\/testbed\/vm-host-adapter-conformance\.mjs/,
    );
    assert.match(conformance, /VEM_VM_HOST_FACTORY_ISO_ID/);
    assert.match(conformance, /VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID/);
    assert.doesNotMatch(conformance, /VEM_VM_HOST_ADAPTER_CONFORMANCE/);
  });

  it("guards certificate SSH, teardown, sanitized diagnostics, and the preconfigured VM relay contract", () => {
    const workflow = readWorkflow();
    assert.doesNotMatch(workflow, /secrets\.[A-Z0-9_]*PASSWORD/);
    const exchange = stepBlock(
      workflow,
      "Exchange OIDC And Create Maintenance Session",
    );
    const startRelay = stepBlock(
      workflow,
      "Start Runner Maintenance Relay WireGuard Peer",
    );
    const preflight = stepBlock(
      workflow,
      "Preflight Maintenance Relay Bootstrap Contract",
    );
    const cleanup = stepBlock(workflow, "Cleanup Ephemeral Services");
    const leakGuard = stepBlock(
      workflow,
      "Guard Maintenance Automation Evidence",
    );

    assert.match(
      exchange,
      /MAINTENANCE_SSH_DIR="\$RUNNER_TEMP\/vem-maintenance-ssh-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.match(exchange, /MAINTENANCE_SSH_DIR=%s.*GITHUB_ENV/);
    assert.match(exchange, /install -d -m 0700 "\$MAINTENANCE_SSH_DIR"/);
    for (const fileName of [
      "id_ed25519",
      "id_ed25519.pub",
      "id_ed25519-cert.pub",
      "certificate-request.json",
      "certificate-response.json",
    ]) {
      assert.match(exchange, requiredTextPattern(fileName));
      assert.match(leakGuard, requiredTextPattern(fileName));
    }
    assert.match(cleanup, /rm -rf -- "\$ssh_directory"/);
    assert.match(cleanup, /cleanup\.sshDirectoryRemoved/);

    assert.doesNotMatch(preflight, /sshpass|SSHPASS/);
    assert.match(
      preflight,
      /vmRelayBootstrapContract=preconfigured-base-image/,
    );
    assert.match(preflight, /repositoryConfiguresVmRelay=false/);
    assert.match(
      preflight,
      /vmWireGuardPeer=must-already-be-configured-and-running-in-base-image/,
    );
    assert.match(
      preflight,
      /windowsControlledMaintenanceIngress=host-configured-runner-peer-only/,
    );

    assert.match(startRelay, /record_config_metadata/);
    assert.match(
      startRelay,
      /record_config_metadata "runnerWireGuardConfig" "\$installed_config_path"/,
    );
    assert.match(startRelay, /\$\{label\}\.sha256=\$\{hash\}/);
    assert.match(startRelay, /\$\{label\}\.permissions=\$\{permissions\}/);
    assert.match(startRelay, /wgShowSummary\.latestHandshakes/);
    assert.doesNotMatch(startRelay, /\bsed\b[\s\S]*PrivateKey/);
    assert.doesNotMatch(startRelay, /\bcat\b[\s\S]*installed_config_path/);
    assert.doesNotMatch(startRelay, /PrivateKey\[|PreSharedKey\[/);

    assert.match(
      cleanup,
      /sudo wg-quick down "\$VEM_MAINTENANCE_RELAY_INTERFACE"/,
    );
    assert.doesNotMatch(cleanup, /sudo rm -f "\$installed_config_path"/);
    assert.doesNotMatch(cleanup, /rm -f "\$temp_config_path"/);
    assert.match(cleanup, /cleanup\.wgQuickDownExit/);
    assert.match(cleanup, /cleanup\.rootOwnedWireGuardConfigPreserved=true/);
  });

  it("keeps the adapter overlay active through acceptance, captures afterward, and always runs adapter cleanup without relabeling adapter failure as SSH readiness", () => {
    const workflow = readWorkflow();
    const restore = stepBlock(
      workflow,
      "Restore Windows Runtime VM Through Host Adapter",
    );
    const acceptance = stepBlock(workflow, "Run VM Runtime Acceptance");
    const display = stepBlock(
      workflow,
      "Capture Windows Display Evidence Through Host Adapter",
    );
    const audio = stepBlock(
      workflow,
      "Capture Windows Default Audio Evidence Through Host Adapter",
    );
    const cleanup = stepBlock(workflow, "Cleanup VM Host Adapter Overlay");

    assert.doesNotMatch(restore, /windowsSshReadiness=failed/);
    assert.match(display, /if:\s+success\(\)/);
    assert.match(audio, /if:\s+success\(\)/);
    assert.match(cleanup, /if:\s+always\(\)/);
    assert.match(cleanup, /--operation cleanup/);
    assert.ok(workflow.indexOf(restore) < workflow.indexOf(acceptance));
    assert.ok(workflow.indexOf(acceptance) < workflow.indexOf(display));
    assert.ok(workflow.indexOf(display) < workflow.indexOf(audio));
    assert.ok(workflow.indexOf(audio) < workflow.indexOf(cleanup));
  });
});
