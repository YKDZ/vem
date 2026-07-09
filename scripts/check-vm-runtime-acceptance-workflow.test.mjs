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
    assert.match(ephemeralServices, /pg_isready -h 127\.0\.0\.1 -p 5432/);
    assert.match(ephemeralServices, /vem-runtime-pg-isready\.log/);
    assert.match(ephemeralServices, /Postgres did not become ready/);
    assert.match(ephemeralServices, /\/dev\/tcp\/127\.0\.0\.1\/18883/);
    assert.match(ephemeralServices, /MQTT did not become ready/);
    assert.doesNotMatch(ephemeralServices, /\n\s*exit 0\n/);
  });

  it("starts runner WireGuard before restoring the VM and uses the VM WireGuard IP for Windows SSH", () => {
    const workflow = readWorkflow();

    for (const requiredText of [
      "vm_wireguard_ip",
      "runner_wireguard_peer_ip",
      "runner_wireguard_interface",
      "VEM_MAINTENANCE_RELAY_RUNNER_WG_CONFIG",
      "VEM_MAINTENANCE_RELAY_RUNNER_WG_CONFIG_PATH",
      "Start Runner Maintenance Relay WireGuard Peer",
      "command -v wg-quick",
      "sudo wg-quick up",
      "MAINTENANCE_RELAY_WINDOWS_SSH_HOST",
      "MAINTENANCE_RELAY_RUNNER_PEER_IP",
      "MAINTENANCE_RELAY_INTERFACE",
      "--maintenance-ingress-source-allowlist",
      "maintenance-relay-diagnostics.txt",
      "windowsSshReadiness=failed",
      "sshpass is required",
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
      /--windows-ssh-host\s+"\$MAINTENANCE_RELAY_WINDOWS_SSH_HOST"/,
    );
    assert.match(restoreBlock, /--sshpass\b/);
    assert.doesNotMatch(
      restoreBlock,
      /--windows-ssh-host\s+"\$\{\{\s*inputs\.windows_ssh_host/,
    );

    const acceptanceBlock = workflow.slice(
      workflow.indexOf("- name: Run VM Runtime Acceptance"),
      workflow.indexOf("- name: Upload VM Runtime Acceptance Artifacts"),
    );
    assert.match(
      acceptanceBlock,
      /--remote\s+"\$\{\{\s*inputs\.windows_ssh_user\s*\}\}@\$MAINTENANCE_RELAY_WINDOWS_SSH_HOST"/,
    );
    assert.match(
      acceptanceBlock,
      /--maintenance-ingress-source-allowlist\s+"\$MAINTENANCE_RELAY_RUNNER_PEER_IP"/,
    );
    assert.match(acceptanceBlock, /--sshpass\b/);
    assert.match(acceptanceBlock, /--factory-credentials-from-sshpass\b/);
    assert.doesNotMatch(acceptanceBlock, /@\$?\{\{\s*inputs\.windows_ssh_host/);
  });

  it("guards password SSH, teardown, sanitized diagnostics, and the preconfigured VM relay contract", () => {
    const workflow = readWorkflow();
    const startRelay = stepBlock(
      workflow,
      "Start Runner Maintenance Relay WireGuard Peer",
    );
    const preflight = stepBlock(
      workflow,
      "Preflight Maintenance Relay Bootstrap Contract",
    );
    const cleanup = stepBlock(workflow, "Cleanup Ephemeral Services");

    assert.match(preflight, /\[ -z "\$\{SSHPASS:-\}" \]/);
    assert.match(preflight, /preflight\.sshpass=missing/);
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
      /windowsControlledMaintenanceIngress=must-already-allow-runner-peer-ip/,
    );

    assert.match(startRelay, /record_config_metadata/);
    assert.match(
      startRelay,
      /record_config_metadata "runnerWireGuardConfig" "\$config_path"/,
    );
    assert.match(
      startRelay,
      /record_config_metadata "installedWireGuardConfigAfterStart" "\$installed_config_path"/,
    );
    assert.match(startRelay, /\$\{label\}\.sha256=\$\{hash\}/);
    assert.match(startRelay, /\$\{label\}\.permissions=\$\{permissions\}/);
    assert.match(startRelay, /wgShowSummary\.latestHandshakes/);
    assert.doesNotMatch(startRelay, /\bsed\b[\s\S]*PrivateKey/);
    assert.doesNotMatch(startRelay, /\bcat\b[\s\S]*config_path/);
    assert.doesNotMatch(startRelay, /PrivateKey\[|PreSharedKey\[/);

    assert.match(cleanup, /sudo wg-quick down "\$MAINTENANCE_RELAY_INTERFACE"/);
    assert.match(cleanup, /sudo rm -f "\$installed_config_path"/);
    assert.match(cleanup, /rm -f "\$temp_config_path"/);
    assert.match(cleanup, /cleanup\.wgQuickDownExit/);
    assert.match(cleanup, /cleanup\.installedConfigRemoved=true/);
    assert.match(cleanup, /cleanup\.tempConfigRemoved=true/);
  });
});
