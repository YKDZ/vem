import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  adapterEnvironment,
  buildFactoryPreclaimVerifyInvocation,
  buildFactoryMachineClaimInvocation,
  buildFactoryRuntimeAcceptanceInvocation,
  materializeFactoryDisplayEvidence,
  prepareSanitizedFactoryAcceptanceUpload,
  runAdmittedFactoryImageAcceptanceLifecycle,
  sanitizeFactoryAcceptanceEvidence,
  validateFactoryImageAcceptanceInput,
} from "./factory-image-acceptance.mjs";

const runner = new URL("./factory-image-acceptance.mjs", import.meta.url)
  .pathname;
const adapter = new URL("./fake-vm-host-adapter.mjs", import.meta.url).pathname;

function typedInput(root) {
  return {
    schemaVersion: "vem-factory-image-acceptance-input/v1",
    kind: "factory-image-acceptance-input",
    runId: "RUN-15-LIFECYCLE",
    targetIdentity: "vm-target://factory-testbed",
    factory: {
      assemblyMode: "windows-serviced-iso",
      targetFirmware: "bios",
      isoIdentity: `factory-cas://sha256/${"a".repeat(64)}`,
      manifestIdentity: `sha256:${"b".repeat(64)}`,
      provenanceIdentity: `factory-evidence://sha256/${"c".repeat(64)}`,
      provenanceDigest: `sha256:${"c".repeat(64)}`,
      manifestPath: "/runner/factory/manifest.json",
      provenancePath: "/runner/factory/provenance.json",
      isoPath: "/runner/factory/image.iso",
      udfExtractorPath: "/runner/factory/7z",
      udfWriterPath: "/runner/factory/genisoimage",
      wimlibPath: "/runner/factory/wimlib-imagex",
    },
    endpoint: {
      expectedTestbedUser: "YKDZ",
      maintenanceRelaySession: {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        relayPeer: {
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: "10.91.0.1",
        },
        sourceTunnelAddress: "10.91.2.10",
        endpointTunnelAddress: "10.91.16.10",
      },
    },
    ephemeralPlatform: {
      evidencePath: join(root, "ephemeral-platform.json"),
      platformTarget: "ephemeral-run-15",
      machineCode: "VEM-TESTBED-WINVM-01",
    },
    ssh: {
      identityPath: "/runner/ssh/maintenance",
      certificatePath: "/runner/ssh/maintenance-cert.pub",
    },
    evidence: {
      root: join(root, "evidence"),
      lifecycleReport: join(root, "evidence", "lifecycle", "report.json"),
      sanitizedUpload: join(root, "evidence", "sanitized-upload"),
    },
  };
}

describe("Factory Image Acceptance lifecycle", () => {
  it("extends only clean-install adapter execution", () => {
    const environment = {
      VEM_VM_HOST_ADAPTER_TIMEOUT_MS: "600000",
      VEM_FACTORY_CLEAN_INSTALL_ADAPTER_TIMEOUT_MS: "2700000",
    };
    assert.equal(
      adapterEnvironment("clean-install", environment)
        .VEM_VM_HOST_ADAPTER_TIMEOUT_MS,
      "2700000",
    );
    assert.strictEqual(adapterEnvironment("cleanup", environment), environment);
    assert.equal(
      adapterEnvironment("cleanup", environment).VEM_VM_HOST_ADAPTER_TIMEOUT_MS,
      "600000",
    );
  });

  it("requires the typed input to bind a supported target firmware", () => {
    const input = typedInput("/tmp/factory-firmware-input");
    assert.equal(
      validateFactoryImageAcceptanceInput(input).factory.targetFirmware,
      "bios",
    );
    input.factory.targetFirmware = "auto";
    assert.throws(
      () => validateFactoryImageAcceptanceInput(input),
      /targetFirmware/,
    );
  });

  it("verifies the installed Factory runtime before base capture and binds claim to the discovered endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-command-"));
    const input = typedInput(root);
    const endpoint = {
      protocol: "ssh",
      host: "10.91.16.10",
      port: 22,
      reachability: "discovered",
      relayProof: {
        ...input.endpoint.maintenanceRelaySession,
        relayPeer: {
          ...input.endpoint.maintenanceRelaySession.relayPeer,
        },
        endpointAllowedIp: "10.91.16.10/32",
        endpointRoute: "10.91.16.10/32",
        handshakeUnixSeconds: 1_784_160_000,
      },
    };
    const sshKnownHostsPath = join(root, "lifecycle-known-hosts");
    const preclaimInvocation = buildFactoryPreclaimVerifyInvocation(
      input,
      endpoint,
      sshKnownHostsPath,
    );
    const claimInvocation = buildFactoryMachineClaimInvocation(
      input,
      endpoint,
      sshKnownHostsPath,
    );
    const runtimeInvocation = buildFactoryRuntimeAcceptanceInvocation(
      input,
      endpoint,
      sshKnownHostsPath,
    );
    assert.deepEqual(preclaimInvocation.slice(0, 4), [
      "node",
      "scripts/testbed/win10-vem-e2e.mjs",
      "--mode",
      "factory-preclaim-verify",
    ]);
    assert.deepEqual(claimInvocation.slice(0, 4), [
      "node",
      "scripts/testbed/win10-vem-e2e.mjs",
      "--mode",
      "provision",
    ]);
    assert.equal(runtimeInvocation[3], "runtime-acceptance");
    for (const invocation of [
      preclaimInvocation,
      claimInvocation,
      runtimeInvocation,
    ]) {
      assert.equal(
        invocation[invocation.indexOf("--ssh-known-hosts-path") + 1],
        sshKnownHostsPath,
      );
    }
    assert.equal(
      preclaimInvocation.includes("--ephemeral-platform-evidence"),
      false,
    );
    assert.equal(
      claimInvocation.indexOf("--ephemeral-platform-evidence") <
        claimInvocation.indexOf("--factory-guest-endpoint-json"),
      true,
    );
    assert.equal(
      JSON.parse(
        preclaimInvocation[
          preclaimInvocation.indexOf("--factory-guest-endpoint-json") + 1
        ],
      ).host,
      "10.91.16.10",
    );
    assert.equal(
      JSON.parse(
        claimInvocation[
          claimInvocation.indexOf("--factory-guest-endpoint-json") + 1
        ],
      ).host,
      "10.91.16.10",
    );
    assert.equal(
      JSON.parse(
        runtimeInvocation[
          runtimeInvocation.indexOf("--factory-guest-endpoint-json") + 1
        ],
      ).host,
      "10.91.16.10",
    );
    assert.throws(
      () =>
        buildFactoryPreclaimVerifyInvocation(
          input,
          {
            ...endpoint,
            relayProof: {
              ...endpoint.relayProof,
              relayPeer: {
                ...endpoint.relayProof.relayPeer,
                publicKey: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
              },
            },
          },
          sshKnownHostsPath,
        ),
      /exact maintenance-session Relay peer/,
    );
    assert.throws(
      () => validateFactoryImageAcceptanceInput({}),
      /schemaVersion/,
    );
    const evidence = sanitizeFactoryAcceptanceEvidence({
      token: "secret",
      path: "/tmp/x",
    });
    assert.equal(evidence.token, undefined);
    assert.equal(evidence.path, "[REDACTED]");
  });

  it("writes sanitized JSON copies into a dedicated upload boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-upload-"));
    try {
      const source = join(root, "evidence");
      const upload = join(root, "sanitized-upload");
      mkdirSync(join(source, "lifecycle"), { recursive: true });
      mkdirSync(join(source, "verifier"), { recursive: true });
      writeFileSync(
        join(source, "lifecycle", "report.json"),
        JSON.stringify({
          status: "passed",
          path: "/workspaces/vem/host-only",
          claimCode: "ABCD-2345",
          nested: { token: "not-for-upload", windowsPath: "C:\\VEM\\secret" },
        }),
      );
      writeFileSync(
        join(source, "verifier", "claim.json"),
        JSON.stringify({ status: "provisioned" }),
      );
      assert.deepEqual(
        prepareSanitizedFactoryAcceptanceUpload({ source, upload }),
        ["lifecycle/report.json", "verifier/claim.json"],
      );
      const uploaded = JSON.parse(
        readFileSync(join(upload, "lifecycle", "report.json"), "utf8"),
      );
      assert.equal(uploaded.claimCode, undefined);
      assert.equal(uploaded.path, "[REDACTED]");
      assert.equal(uploaded.nested.token, undefined);
      assert.equal(uploaded.nested.windowsPath, "[REDACTED]");
      assert.notEqual(
        readFileSync(join(upload, "lifecycle", "report.json"), "utf8"),
        readFileSync(join(source, "lifecycle", "report.json"), "utf8"),
      );
      assert.throws(() => {
        writeFileSync(join(source, "lifecycle", "private.txt"), "private");
        prepareSanitizedFactoryAcceptanceUpload({ source, upload });
      }, /artifact type/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes only the digest-verified display export without a host path", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-display-"));
    const input = typedInput(root);
    const exportDirectory = join(root, "evidence", "adapter-export");
    const bytes = Buffer.from("display screenshot evidence\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fileName = `${hash}.png`;
    const operationReference = "vm-operation://op-0123456789abcdef";
    const operationDirectory = join(
      exportDirectory,
      input.runId,
      "op-0123456789abcdef",
    );
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(join(operationDirectory, fileName), bytes);
    try {
      assert.deepEqual(
        materializeFactoryDisplayEvidence(input, {
          evidence: [
            {
              role: "display-capture",
              identity: `factory-evidence://sha256/${hash}`,
              digest: `sha256:${hash}`,
              fileName,
            },
          ],
          request: { runId: input.runId, operationReference },
        }),
        {
          status: "copied",
          role: "display-capture",
          identity: `factory-evidence://sha256/${hash}`,
          digest: `sha256:${hash}`,
          fileName,
        },
      );
      assert.deepEqual(
        readFileSync(join(input.evidence.root, "screenshots", fileName)),
        bytes,
      );
      writeFileSync(join(operationDirectory, fileName), "tampered");
      assert.throws(
        () =>
          materializeFactoryDisplayEvidence(input, {
            evidence: [
              {
                role: "display-capture",
                identity: `factory-evidence://sha256/${hash}`,
                digest: `sha256:${hash}`,
                fileName,
              },
            ],
            request: { runId: input.runId, operationReference },
          }),
        /does not match adapter digest/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("always recovers an admitted factory lifecycle when clean install fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-lifecycle-"));
    const input = typedInput(root);
    writeFileSync(input.ephemeralPlatform.evidencePath, "{}\n");
    const environment = {
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      VEM_VM_HOST_ADAPTER: process.env.VEM_VM_HOST_ADAPTER,
      VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID:
        process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID,
      VEM_VM_HOST_ADAPTER_FAIL_OPERATION:
        process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION,
      VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY:
        process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY,
    };
    try {
      process.env.RUNNER_TEMP = root;
      process.env.VEM_VM_HOST_ADAPTER = adapter;
      process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID = `factory-cas://sha256/${"d".repeat(64)}`;
      process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION = "clean-install";
      process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY = "1";
      await assert.rejects(() =>
        runAdmittedFactoryImageAcceptanceLifecycle(input, {
          manifestIdentity: input.factory.manifestIdentity,
          provenanceDigest: input.factory.provenanceDigest,
          outputIdentity: input.factory.isoIdentity,
          outputDigest: `sha256:${"a".repeat(64)}`,
          effectiveInputsDigest: `sha256:${"e".repeat(64)}`,
        }),
      );
      assert.deepEqual(
        readdirSync(root).filter((entry) =>
          entry.startsWith("factory-ssh-trust-"),
        ),
        [],
      );
      const report = JSON.parse(
        readFileSync(input.evidence.lifecycleReport, "utf8"),
      );
      assert.equal(report.reports.preclaimVerify, undefined);
      assert.equal(
        report.reports.cleanup.cleanup.overlayDisposition,
        "removed",
      );
      assert.equal(
        report.reports.cleanup.observed.baseIdentity,
        `factory-cas://sha256/${"a".repeat(64)}`,
      );
      assert.equal(report.reports.cleanup.request.factoryMedia, null);
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-captures the same approved base and rehashes preclaim evidence after cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-preservation-"));
    const input = typedInput(root);
    const bin = join(root, "bin");
    const ssh = join(bin, "ssh");
    const adapterLog = join(root, "adapter-operations.log");
    mkdirSync(bin);
    writeFileSync(
      ssh,
      `#!/bin/sh
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true}}}'
`,
      { mode: 0o700 },
    );
    chmodSync(ssh, 0o700);
    writeFileSync(input.ephemeralPlatform.evidencePath, "{}\n");
    const environment = {
      PATH: process.env.PATH,
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      VEM_VM_HOST_ADAPTER: process.env.VEM_VM_HOST_ADAPTER,
      VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID:
        process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID,
      VEM_VM_HOST_ADAPTER_FAIL_OPERATION:
        process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION,
      VEM_VM_HOST_ADAPTER_OPERATION_LOG:
        process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG,
      VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY:
        process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY,
    };
    try {
      process.env.PATH = `${bin}:${process.env.PATH}`;
      process.env.RUNNER_TEMP = root;
      process.env.VEM_VM_HOST_ADAPTER = adapter;
      process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID = `factory-cas://sha256/${"d".repeat(64)}`;
      process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION =
        "create-disposable-overlay";
      process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG = adapterLog;
      process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY = "1";
      await assert.rejects(() =>
        runAdmittedFactoryImageAcceptanceLifecycle(input, {
          manifestIdentity: input.factory.manifestIdentity,
          provenanceDigest: input.factory.provenanceDigest,
          outputIdentity: input.factory.isoIdentity,
          outputDigest: `sha256:${"a".repeat(64)}`,
          effectiveInputsDigest: `sha256:${"e".repeat(64)}`,
        }),
      );
      const report = JSON.parse(
        readFileSync(input.evidence.lifecycleReport, "utf8"),
      );
      assert.equal(
        report.reports.postCleanup.captureApprovedBase.observed.baseIdentity,
        `factory-cas://sha256/${"f".repeat(64)}`,
      );
      assert.equal(
        report.reports.postCleanup.captureApprovedBase.request.factoryMedia
          .outputIdentity,
        input.factory.isoIdentity,
      );
      assert.equal(report.reports.postCleanup.preclaimEvidence.unchanged, true);
      assert.equal(
        report.reports.postCleanup.finalCleanup.cleanup.overlayDisposition,
        "removed",
      );
      assert.equal(
        report.reports.postCleanup.finalCleanup.observed.baseIdentity,
        `factory-cas://sha256/${"f".repeat(64)}`,
      );
      assert.equal(
        readFileSync(adapterLog, "utf8")
          .trim()
          .split("\n")
          .filter((operation) => operation === "capture-approved-base").length,
        2,
      );
      const operations = readFileSync(adapterLog, "utf8").trim().split("\n");
      assert.equal(operations.at(-1), "cleanup");
      assert.ok(
        operations.lastIndexOf("cleanup") >
          operations.lastIndexOf("capture-approved-base"),
      );
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs terminal cleanup when post-cleanup base verification fails", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "vem-factory-image-final-cleanup-"),
    );
    const input = typedInput(root);
    const bin = join(root, "bin");
    const ssh = join(bin, "ssh");
    const adapterLog = join(root, "adapter-operations.log");
    const recaptureAdapter = join(root, "recapture-mismatch-adapter.mjs");
    const captureCount = join(root, "capture-count");
    mkdirSync(bin);
    writeFileSync(
      ssh,
      `#!/bin/sh
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true}}}'
`,
      { mode: 0o700 },
    );
    writeFileSync(
      recaptureAdapter,
      `import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const requestPath = args[args.indexOf("--request") + 1];
const reportPath = args[args.indexOf("--report") + 1];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const result = spawnSync(process.execPath, [${JSON.stringify(adapter)}, ...args], {
  env: process.env,
  encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
if (request.operation === "capture-approved-base") {
  const count = existsSync(${JSON.stringify(captureCount)})
    ? Number(readFileSync(${JSON.stringify(captureCount)}, "utf8")) + 1
    : 1;
  writeFileSync(${JSON.stringify(captureCount)}, String(count));
  if (count === 2) {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.observed.baseIdentity = "factory-cas://sha256/${"0".repeat(64)}";
    writeFileSync(reportPath, JSON.stringify(report));
  }
}
`,
      { mode: 0o700 },
    );
    chmodSync(ssh, 0o700);
    chmodSync(recaptureAdapter, 0o700);
    writeFileSync(input.ephemeralPlatform.evidencePath, "{}\n");
    const environment = {
      PATH: process.env.PATH,
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      VEM_VM_HOST_ADAPTER: process.env.VEM_VM_HOST_ADAPTER,
      VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID:
        process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID,
      VEM_VM_HOST_ADAPTER_FAIL_OPERATION:
        process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION,
      VEM_VM_HOST_ADAPTER_OPERATION_LOG:
        process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG,
      VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY:
        process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY,
    };
    try {
      process.env.PATH = `${bin}:${process.env.PATH}`;
      process.env.RUNNER_TEMP = root;
      process.env.VEM_VM_HOST_ADAPTER = recaptureAdapter;
      process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID = `factory-cas://sha256/${"d".repeat(64)}`;
      process.env.VEM_VM_HOST_ADAPTER_FAIL_OPERATION =
        "create-disposable-overlay";
      process.env.VEM_VM_HOST_ADAPTER_OPERATION_LOG = adapterLog;
      process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY = "1";
      await assert.rejects(
        () =>
          runAdmittedFactoryImageAcceptanceLifecycle(input, {
            manifestIdentity: input.factory.manifestIdentity,
            provenanceDigest: input.factory.provenanceDigest,
            outputIdentity: input.factory.isoIdentity,
            outputDigest: `sha256:${"a".repeat(64)}`,
            effectiveInputsDigest: `sha256:${"e".repeat(64)}`,
          }),
        /post-cleanup approved base identity or digest changed/,
      );
      const operations = readFileSync(adapterLog, "utf8").trim().split("\n");
      assert.equal(operations.at(-1), "cleanup");
      assert.ok(
        operations.lastIndexOf("cleanup") >
          operations.lastIndexOf("capture-approved-base"),
      );
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale Factory provenance identity before any adapter operation", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-admission-"));
    const input = typedInput(root);
    const inputPath = join(root, "input.json");
    const adapterLog = join(root, "adapter-operations.log");
    input.factory.provenanceIdentity = `factory-evidence://sha256/${"d".repeat(64)}`;
    writeFileSync(input.ephemeralPlatform.evidencePath, "{}\n");
    writeFileSync(inputPath, JSON.stringify(input));
    try {
      const result = spawnSync(process.execPath, [runner], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH: inputPath,
          VEM_VM_HOST_ADAPTER: adapter,
          VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY: "1",
          VEM_VM_HOST_ADAPTER_OPERATION_LOG: adapterLog,
          VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID: `factory-cas://sha256/${"d".repeat(64)}`,
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /provenanceIdentity/i);
      assert.equal(existsSync(adapterLog), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs adapter cleanup-only independently and requires removal proof", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-cleanup-"));
    const input = typedInput(root);
    const inputPath = join(root, "input.json");
    writeFileSync(input.ephemeralPlatform.evidencePath, "{}\n");
    writeFileSync(inputPath, JSON.stringify(input));
    try {
      const result = spawnSync(process.execPath, [runner, "--cleanup-only"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH: inputPath,
          VEM_VM_HOST_ADAPTER: adapter,
          VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY: "1",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(
        readFileSync(
          join(dirname(input.evidence.lifecycleReport), "adapter-cleanup.json"),
          "utf8",
        ),
      );
      assert.equal(report.cleanup.overlayDisposition, "removed");
      assert.equal(report.cleanup.observed.personalizationMedia, "removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs factory-preclaim-verify through only the adapter-discovered SSH endpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-preclaim-cli-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const ssh = join(bin, "ssh");
      writeFileSync(
        ssh,
        `#!/bin/sh
printf '%s\\n' "$@" > ${join(root, "ssh-args.txt")}
cat > ${join(root, "ssh-stdin.ps1")}
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true}}}'
`,
        { mode: 0o700 },
      );
      chmodSync(ssh, 0o700);
      const output = join(root, "preclaim.json");
      const lifecycleKnownHosts = join(root, "lifecycle-known-hosts");
      writeFileSync(lifecycleKnownHosts, "retained-by-parent\n", {
        mode: 0o600,
      });
      const result = spawnSync(
        process.execPath,
        [
          runner.replace("factory-image-acceptance.mjs", "win10-vem-e2e.mjs"),
          "--mode",
          "factory-preclaim-verify",
          "--run-id",
          "RUN-15-LIFECYCLE",
          "--machine-code",
          "VEM-TESTBED-WINVM-01",
          "--expected-testbed-user",
          "YKDZ",
          "--identity",
          "/tmp/identity",
          "--certificate",
          "/tmp/certificate",
          "--ssh-known-hosts-path",
          lifecycleKnownHosts,
          "--factory-guest-endpoint-json",
          JSON.stringify({
            protocol: "ssh",
            host: "10.91.2.10",
            port: 2222,
            reachability: "discovered",
          }),
          "--out",
          output,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(readFileSync(output, "utf8")).readOnly, true);
      const sshArgs = readFileSync(join(root, "ssh-args.txt"), "utf8");
      const sshStdin = readFileSync(join(root, "ssh-stdin.ps1"), "utf8");
      assert.match(sshArgs, /-p\n2222\n/);
      assert.match(sshArgs, /YKDZ@10\.91\.2\.10/);
      assert.match(sshArgs, /powershell -NoLogo -NoProfile -NonInteractive/);
      assert.match(sshArgs, /-Command -/);
      assert.doesNotMatch(sshArgs, /-EncodedCommand/);
      assert.ok(sshArgs.length < 4096);
      assert.match(sshStdin, /verify-factory-runtime\.ps1/);
      assert.match(sshStdin, /factory-preclaim-verification\/v1/);
      assert.match(sshStdin, /absentMachineIdentity/);
      assert.ok(sshStdin.endsWith("\n\n"));
      assert.match(sshArgs, /StrictHostKeyChecking=accept-new/);
      assert.match(
        sshArgs,
        new RegExp(`UserKnownHostsFile=${lifecycleKnownHosts}`),
      );
      assert.match(sshArgs, /HostKeyAlias=vem-factory-run-15-lifecycle/);
      assert.equal(
        readFileSync(lifecycleKnownHosts, "utf8"),
        "retained-by-parent\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
