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

describe("VM runtime acceptance workflow local direct path", () => {
  it("removes the external maintenance control plane and token exchange path", () => {
    const workflow = readWorkflow();

    for (const forbidden of [
      /maintenance-automation\//,
      /MAINTENANCE_CONTROL_PLANE/,
      /ACTIONS_ID_TOKEN_REQUEST/,
      /automation-token\.jwt/,
      /Exchange OIDC And Create Maintenance Session/,
      /id-token:\s*write/,
      /VEM_MAINTENANCE_RUNNER_ENDPOINT_VISIBLE_SOURCE/,
      /MAINTENANCE_TARGET_MACHINE_ID/,
      /MAINTENANCE_RUNNER_PEER_ID/,
    ]) {
      assert.doesNotMatch(workflow, forbidden);
    }

    assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read/);
    assert.match(workflow, /Guard Local VM Runtime Trust Boundary/);
    assert.doesNotMatch(workflow, /runner\.labels|RUNNER_LABELS_JSON/);
    assert.doesNotMatch(workflow, /vm-host-adapter-conformance\.mjs/);
  });

  it("does not start or prove a runner relay or maintenance port-security path", () => {
    const workflow = readWorkflow();

    for (const forbidden of [
      /wg-quick/,
      /sudo wg\b/,
      /\bWireGuard\b/,
      /VEM_MAINTENANCE_RELAY_/,
      /maintenance-relay-diagnostics\.txt/,
      /wireguard-ssh-data-plane\.json/,
      /Accept Windows LocalSystem WireGuard Claim To Handshake/,
      /test-wireguard-localsystem-acceptance\.ps1/,
      /Prove Relay WireGuard SSH Data Plane/,
      /--maintenance-ingress-source-allowlist/,
      /runner_wireguard_/,
      /vm_wireguard_ip/,
    ]) {
      assert.doesNotMatch(workflow, forbidden);
    }

    assert.match(workflow, /Prove Direct Certificate SSH Data Plane/);
    assert.match(workflow, /direct-ssh-certificate-proof\.json/);
  });

  it("runs Postgres, MQTT, and service-api on the configured self-hosted runner while keeping the database local to service-api", () => {
    const workflow = readWorkflow();
    const guard = stepBlock(workflow, "Guard Local VM Runtime Trust Boundary");
    const postgresAndMqtt = stepBlock(
      workflow,
      "Start Ephemeral Postgres And MQTT",
    );
    const serviceApi = stepBlock(workflow, "Build And Start Service API");
    const runtime = stepBlock(workflow, "Run VM Runtime Acceptance");

    assert.match(
      runtime,
      /--maintenance-relay-peer-id\s+"\$MAINTENANCE_RELAY_PEER_ID"/,
    );
    assert.match(
      runtime,
      /--maintenance-relay-public-key\s+"\$MAINTENANCE_RELAY_PUBLIC_KEY"/,
    );
    assert.match(
      runtime,
      /--maintenance-relay-tunnel-address\s+"\$MAINTENANCE_RELAY_TUNNEL_ADDRESS"/,
    );

    assert.match(
      workflow,
      /VEM_RUNTIME_PLATFORM_HOST:\s+\$\{\{ vars\.VEM_VM_RUNTIME_PLATFORM_INGRESS_HOST \}\}/,
    );
    assert.match(
      workflow,
      /VEM_RUNTIME_RUNNER_SOURCE_ALLOWLIST:\s+\$\{\{ vars\.VEM_VM_RUNTIME_RUNNER_SOURCE_ALLOWLIST \}\}/,
    );
    assert.match(
      workflow,
      /MACHINE_CLAIM_LOOKUP_HMAC_KEY:\s+ci-machine-claim-lookup-hmac-key-v1/,
    );
    assert.match(
      workflow,
      /EPHEMERAL_API_BASE_URL:\s+\$\{\{ format\('http:\/\/\{0\}:26849\/api'/,
    );
    assert.match(
      workflow,
      /EPHEMERAL_MQTT_URL:\s+\$\{\{ format\('mqtt:\/\/\{0\}:18883'/,
    );
    assert.match(
      workflow,
      /DATABASE_URL:\s+postgresql:\/\/vem:vem_password@127\.0\.0\.1:55432\/vem_runtime/,
    );
    assert.match(guard, /ip -o -4 addr show scope global/);
    assert.match(
      guard,
      /VEM_RUNTIME_PLATFORM_HOST must be the runner's LAN IPv4 address/,
    );
    assert.match(guard, /grep -Fx "\$VEM_RUNTIME_PLATFORM_HOST"/);
    assert.doesNotMatch(workflow, /192\.168\.2\.23/);

    assert.match(postgresAndMqtt, /postgres_name=/);
    assert.match(postgresAndMqtt, /mqtt_name=/);
    assert.match(postgresAndMqtt, /-p 55432:5432/);
    assert.match(postgresAndMqtt, /-p 18883:1883/);
    assert.match(postgresAndMqtt, /wait_for_tcp 127\.0\.0\.1 55432/);
    assert.match(postgresAndMqtt, /wait_for_tcp 127\.0\.0\.1 18883/);
    assert.doesNotMatch(postgresAndMqtt, /docker exec/);

    assert.match(serviceApi, /SERVICE_HOST:\s+"0\.0\.0\.0"/);
    assert.match(serviceApi, /SERVICE_PORT:\s+"26849"/);
    assert.match(
      serviceApi,
      /MACHINE_API_BASE_URL:\s+\$\{\{ env\.EPHEMERAL_API_BASE_URL \}\}/,
    );
    assert.match(
      serviceApi,
      /MACHINE_MQTT_URL:\s+\$\{\{ env\.EPHEMERAL_MQTT_URL \}\}/,
    );
    assert.match(serviceApi, /MQTT_URL:\s+mqtt:\/\/127\.0\.0\.1:18883/);
    assert.match(
      serviceApi,
      /MAINTENANCE_RELAY_ENDPOINT:\s+127\.0\.0\.1:51820/,
    );
    assert.match(
      serviceApi,
      /curl --globoff -fsS "\$EPHEMERAL_API_READY_URL\/health"/,
    );
    assert.doesNotMatch(serviceApi, /\n\s+PORT:\s+"26849"/);

    assert.match(
      runtime,
      /--ephemeral-api-base-url\s+"\$EPHEMERAL_API_BASE_URL"/,
    );
    assert.match(runtime, /--ephemeral-mqtt-url\s+"\$EPHEMERAL_MQTT_URL"/);
    assert.doesNotMatch(runtime, /127\.0\.0\.1:26849\/api/);
  });

  it("creates run-scoped certificate SSH material from a local Factory or testbed CA", () => {
    const workflow = readWorkflow();
    const access = stepBlock(workflow, "Prepare Local VM Testbed SSH Access");
    const cleanup = stepBlock(workflow, "Cleanup Ephemeral Services");
    const leakGuard = stepBlock(
      workflow,
      "Guard Local VM Acceptance Credential Evidence",
    );

    assert.match(
      access,
      /ca_key_path="\$\{VEM_VM_RUNTIME_SSH_CA_PRIVATE_KEY_PATH:-\$\{VEM_FACTORY_MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH:-\$\{VEM_TESTBED_MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH:-\}\}\}"/,
    );
    assert.match(
      access,
      /ssh_dir="\$RUNNER_TEMP\/vem-vm-runtime-ssh-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.match(access, /ssh-keygen -q -t ed25519 -N '' -f "\$ssh_key_path"/);
    assert.match(access, /ssh-keygen -q -s "\$ca_key_path"/);
    assert.match(
      access,
      /-I "vem-vm-runtime-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
    );
    assert.match(access, /-n "\$WINDOWS_SSH_USER"/);
    assert.match(access, /-V -5m:\+150m/);
    assert.match(access, /ssh-keygen -Lf "\$ssh_certificate_path"/);
    assert.match(access, /local-ssh-certificate\.txt/);

    for (const required of [
      "VM_RUNTIME_SSH_DIR",
      "VM_RUNTIME_SSH_KNOWN_HOSTS_PATH",
      "VM_RUNTIME_SSH_HOST_KEY_ALIAS",
      "VM_TESTBED_MAINTENANCE_SESSION_JSON",
      "VM_TESTBED_ENDPOINT_POLICY_JSON",
      "VM_TESTBED_SERIAL_ENDPOINT_POLICY_JSON",
    ]) {
      assert.match(access, requiredTextPattern(required));
    }
    assert.doesNotMatch(access, /const serialLifecycle/);
    assert.match(
      access,
      /VM_TESTBED_SERIAL_ENDPOINT_POLICY_JSON=\$\{JSON\.stringify\(policy\(adapterLifecycle\)\)\}/,
    );

    for (const fileName of [
      "id_ed25519",
      "id_ed25519.pub",
      "id_ed25519-cert.pub",
      "known_hosts",
    ]) {
      assert.match(leakGuard, requiredTextPattern(fileName));
    }
    assert.match(cleanup, /rm -rf -- "\$ssh_directory"/);
    assert.match(cleanup, /cleanup\.sshDirectoryRemoved/);
  });

  it("uses VM host adapter testbed-runner-direct endpoints for overlay, serial conformance, display, and audio capture", () => {
    const workflow = readWorkflow();
    const access = stepBlock(workflow, "Prepare Local VM Testbed SSH Access");
    const overlay = stepBlock(
      workflow,
      "Create Windows Runtime VM Direct Testbed Overlay",
    );
    const endpoint = stepBlock(
      workflow,
      "Consume Direct Testbed Guest Maintenance Endpoint",
    );
    const runtime = stepBlock(workflow, "Run VM Runtime Acceptance");
    const display = stepBlock(
      workflow,
      "Capture Windows Display Evidence Through Host Adapter",
    );
    const audio = stepBlock(
      workflow,
      "Capture Windows Default Audio Evidence Through Host Adapter",
    );

    assert.match(access, /transport: "testbed-runner-direct"/);
    assert.match(
      access,
      /runnerSourceAllowlist: \[process\.env\.VEM_RUNTIME_RUNNER_SOURCE_ALLOWLIST\]/,
    );
    assert.match(
      access,
      /vm-lifecycle:\/\/\$\{runId\.toLowerCase\(\)\}\.\$\{lifecycleSeed\}/,
    );
    assert.match(overlay, /--operation create-disposable-overlay/);
    assert.match(
      overlay,
      /--approved-runtime-base\s+"\$VEM_VM_HOST_APPROVED_BASE_ID"/,
    );
    assert.match(
      overlay,
      /--maintenance-relay-session-json\s+"\$VM_TESTBED_MAINTENANCE_SESSION_JSON"/,
    );
    assert.match(
      overlay,
      /--maintenance-endpoint-policy-json\s+"\$VM_TESTBED_ENDPOINT_POLICY_JSON"/,
    );
    assert.doesNotMatch(overlay, /restore-approved-base/);

    assert.match(endpoint, /endpoint\?\.transport !== "testbed-runner-direct"/);
    assert.match(endpoint, /endpoint\?\.protocol !== "ssh"/);
    assert.match(endpoint, /endpoint\.relayProof !== undefined/);
    assert.match(
      endpoint,
      /VM_GUEST_MAINTENANCE_ENDPOINT_JSON=\$\{JSON\.stringify\(endpoint\)\}/,
    );

    assert.match(
      runtime,
      /--factory-guest-endpoint-json\s+"\$VM_GUEST_MAINTENANCE_ENDPOINT_JSON"/,
    );
    assert.match(
      runtime,
      /--maintenance-relay-session-json\s+"\$VM_TESTBED_MAINTENANCE_SESSION_JSON"/,
    );
    assert.match(
      runtime,
      /--maintenance-endpoint-policy-json\s+"\$VM_TESTBED_SERIAL_ENDPOINT_POLICY_JSON"/,
    );
    assert.match(runtime, /--identity\s+"\$VM_RUNTIME_SSH_DIR\/id_ed25519"/);
    assert.match(
      runtime,
      /--certificate\s+"\$VM_RUNTIME_SSH_DIR\/id_ed25519-cert\.pub"/,
    );
    assert.match(runtime, /--scanner-code-file/);
    assert.match(runtime, /--approved-runtime-base/);
    assert.doesNotMatch(runtime, /mock-payment/);

    for (const block of [display, audio]) {
      assert.match(
        block,
        /--maintenance-relay-session-json\s+"\$VM_TESTBED_MAINTENANCE_SESSION_JSON"/,
      );
      assert.match(
        block,
        /--maintenance-endpoint-policy-json\s+"\$VM_TESTBED_ENDPOINT_POLICY_JSON"/,
      );
    }
  });

  it("proves direct certificate SSH before running full normal and route-competition acceptance", () => {
    const workflow = readWorkflow();
    const sshProof = stepBlock(
      workflow,
      "Prove Direct Certificate SSH Data Plane",
    );
    const runtime = stepBlock(workflow, "Run VM Runtime Acceptance");
    const bindAudioSession = stepBlock(
      workflow,
      "Bind Refreshed Kiosk Session For Native Audio Capture",
    );
    const display = stepBlock(
      workflow,
      "Capture Windows Display Evidence Through Host Adapter",
    );
    const audio = stepBlock(
      workflow,
      "Capture Windows Default Audio Evidence Through Host Adapter",
    );
    const verifyAudio = stepBlock(
      workflow,
      "Verify Windows Native Audio Evidence",
    );
    const cleanup = stepBlock(workflow, "Cleanup VM Host Adapter Overlay");

    assert.match(
      sshProof,
      /CertificateFile=\$VM_RUNTIME_SSH_DIR\/id_ed25519-cert\.pub/,
    );
    assert.match(
      sshProof,
      /UserKnownHostsFile=\$VM_RUNTIME_SSH_KNOWN_HOSTS_PATH/,
    );
    assert.match(sshProof, /HostKeyAlias=\$VM_RUNTIME_SSH_HOST_KEY_ALIAS/);
    assert.match(sshProof, /PasswordAuthentication=no/);
    assert.match(sshProof, /PreferredAuthentications=publickey/);
    assert.match(sshProof, /whoami \| Out-Null/);
    assert.doesNotMatch(sshProof, /-b "\$/);
    assert.doesNotMatch(sshProof, /sshpass|SSHPASS/);

    assert.match(runtime, /win10-vem-e2e\.mjs/);
    assert.match(runtime, /--mode vm-runtime-acceptance/);
    assert.match(runtime, /VEM_EPHEMERAL_DATABASE_URL="\$DATABASE_URL"/);
    assert.match(runtime, /--factory-guest-endpoint-json/);

    assert.match(bindAudioSession, /win10-runtime-acceptance-report\.json/);
    assert.match(bindAudioSession, /postSaleRuntimeAcceptance !== "passed"/);
    assert.match(bindAudioSession, /kiosk\.cdpListenerProcessId/);
    assert.match(bindAudioSession, /kiosk\.cdpMachineAncestorProcessId/);
    assert.match(bindAudioSession, /VEM_ACTIVE_KIOSK_CDP_TARGET_ID/);
    assert.match(display, /if:\s+success\(\)/);
    assert.match(display, /--tauri-route\s+"\$VEM_ACTIVE_KIOSK_TAURI_ROUTE"/);
    assert.match(audio, /if:\s+success\(\)/);
    assert.match(audio, /--selected-audio-endpoint-id/);
    assert.match(audio, /--daemon-calibration-response-out/);
    assert.match(verifyAudio, /windows-native-audio-evidence\.mjs/);
    assert.match(cleanup, /if:\s+always\(\)/);
    assert.match(cleanup, /--operation cleanup/);

    assert.ok(workflow.indexOf(sshProof) < workflow.indexOf(runtime));
    assert.ok(workflow.indexOf(runtime) < workflow.indexOf(bindAudioSession));
    assert.ok(workflow.indexOf(bindAudioSession) < workflow.indexOf(display));
    assert.ok(workflow.indexOf(display) < workflow.indexOf(audio));
    assert.ok(workflow.indexOf(audio) < workflow.indexOf(verifyAudio));
    assert.ok(workflow.indexOf(verifyAudio) < workflow.indexOf(cleanup));
  });

  it("runs the production serial COM and scanner sale conformance with protected scanner input", () => {
    const workflow = readWorkflow();
    const prepareScanner = stepBlock(
      workflow,
      "Prepare Protected Simulated Scanner Code",
    );
    const runtime = stepBlock(workflow, "Run VM Runtime Acceptance");
    const removeScanner = stepBlock(
      workflow,
      "Remove Protected Simulated Scanner Code",
    );
    const display = stepBlock(
      workflow,
      "Capture Windows Display Evidence Through Host Adapter",
    );

    assert.match(runtime, /VEM_VM_HOST_SCANNER_CODE_FILE/);
    assert.match(runtime, /--scanner-code-file/);
    assert.match(runtime, /stat -c '%a'/);
    assert.doesNotMatch(runtime, /VEM_VM_HOST_SCANNER_CODE(?:[^_]|$)/);
    assert.match(prepareScanner, /umask 077/);
    assert.match(prepareScanner, /RUNNER_TEMP/);
    assert.match(prepareScanner, /chmod 600/);
    assert.match(prepareScanner, /randomInt/);
    assert.match(removeScanner, /if: always\(\)/);
    assert.ok(workflow.indexOf(prepareScanner) < workflow.indexOf(runtime));
    assert.ok(workflow.indexOf(runtime) < workflow.indexOf(removeScanner));
    assert.ok(workflow.indexOf(runtime) < workflow.indexOf(display));
  });

  it("deploys the daemon and kiosk UI from one Windows runtime artifact set", () => {
    const workflow = readWorkflow();
    const deploy = stepBlock(
      workflow,
      "Deploy Current Windows Runtime To Overlay",
    );

    for (const artifact of [
      "vending-daemon.exe",
      "machine.exe",
      "WebView2Loader.dll",
    ]) {
      assert.match(deploy, requiredTextPattern(artifact));
    }
    assert.match(deploy, /Stop-ScheduledTask -TaskName "VEMMachineUI"/);
    assert.match(deploy, /Start-ScheduledTask -TaskName "VEMMachineUI"/);
    assert.match(deploy, /component = "daemon"/);
    assert.match(deploy, /component = "ui"/);
  });

  it("uses a portable runner-local runtime artifact cache by default", () => {
    const workflow = readWorkflow();
    const restore = stepBlock(
      workflow,
      "Restore Host Windows Runtime Artifact Cache",
    );
    const persist = stepBlock(
      workflow,
      "Persist Host Windows Runtime Artifact Cache",
    );

    assert.match(restore, /\$\{RUNNER_TEMP%\/_temp\}\/_runtime-artifact-cache/);
    assert.match(persist, /\$\{RUNNER_TEMP%\/_temp\}\/_runtime-artifact-cache/);
    assert.doesNotMatch(`${restore}\n${persist}`, /\/opt\//);
  });
});
