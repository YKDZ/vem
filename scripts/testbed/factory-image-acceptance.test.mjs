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
  buildFactoryInstalledKioskSaleInvocation,
  buildFactoryPreclaimVerifyInvocation,
  buildFactoryMachineClaimInvocation,
  buildFactoryRuntimeAcceptanceInvocation,
  materializeFactoryDisplayEvidence,
  prepareSanitizedFactoryAcceptanceUpload,
  runAdmittedFactoryImageAcceptanceLifecycle,
  sanitizeFactoryAcceptanceEvidence,
  validateFactoryImageAcceptanceInput,
  verifyInstalledKioskSaleScenarioResult,
} from "./factory-image-acceptance.mjs";

const runner = new URL("./factory-image-acceptance.mjs", import.meta.url)
  .pathname;
const adapter = new URL("./fake-vm-host-adapter.mjs", import.meta.url).pathname;

function typedInput(root) {
  const now = Date.now();
  const startedAt = new Date(now - 10_000).toISOString();
  const completedAt = new Date(now).toISOString();
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
        sessionId: "550e8400-e29b-41d4-a716-446655440001",
        relayPeer: {
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
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
    maintenanceRelayAttestation: {
      schemaVersion: "factory-maintenance-relay-attestation/v1",
      kind: "factory-maintenance-relay-attestation",
      source: "runner-wireguard",
      startedAt,
      completedAt,
      session: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        kind: "ci",
        status: "active",
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
        sourcePeer: {
          id: "550e8400-e29b-41d4-a716-446655440002",
          role: "runner",
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: "10.91.2.10",
        },
        targetMachine: {
          id: "550e8400-e29b-41d4-a716-446655440003",
          maintenancePeerId: "550e8400-e29b-41d4-a716-446655440004",
          tunnelAddress: "10.91.16.10",
        },
        relay: {
          id: "550e8400-e29b-41d4-a716-446655440005",
          role: "relay",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: "10.91.0.1",
          endpoint: "relay.example.test:51820",
        },
        relayConvergence: { state: "applied" },
      },
      runner: {
        interface: "wg-factory",
        relayPeer: {
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          endpoint: "relay.example.test:51820",
          allowedIps: ["10.91.16.10/32"],
          latestHandshakeEpochSeconds: Math.floor(now / 1000),
        },
        route: {
          destination: "10.91.16.10/32",
          device: "wg-factory",
          source: "10.91.2.10",
        },
      },
    },
    evidence: {
      root: join(root, "evidence"),
      lifecycleReport: join(root, "evidence", "lifecycle", "report.json"),
      sanitizedUpload: join(root, "evidence", "sanitized-upload"),
    },
  };
}

function overlayEndpoint(input) {
  return {
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
}

function runtimeAcceptanceSummary() {
  return {
    status: "passed",
    runtimeReady: {
      status: "passed",
      asserted: true,
    },
    displayBinding: {
      activeKioskSession: {
        sessionUser: "VEMKiosk",
        sessionId: 1,
      },
      tauriRoute: "http://tauri.localhost/#/sale",
      cdpTargetId: "machine-ui-cdp-target-1",
    },
  };
}

function writeRuntimeAcceptanceVerifier(input) {
  const report = {
    ok: true,
    runtimeAcceptanceReport: {
      schemaVersion: "runtime-acceptance-report/v1",
      result: { runtimeReady: { status: "passed", asserted: true } },
      kioskRuntime: {
        sessionUser: "VEMKiosk",
        sessionId: 1,
        url: "http://tauri.localhost/#/sale",
        cdpTargetId: "machine-ui-cdp-target-1",
      },
    },
  };
  const path = join(input.evidence.root, "verifier", "runtime-acceptance.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report)}\n`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function linkedSale() {
  return {
    checkout: { idempotencyKey: "checkout-factory-1" },
    order: {
      orderId: "order-factory-1",
      checkoutIdempotencyKey: "checkout-factory-1",
      status: "fulfilled",
    },
    reservation: {
      reservationId: "reservation-factory-1",
      orderId: "order-factory-1",
      status: "consumed",
    },
    payment: {
      paymentId: "payment-factory-1",
      orderId: "order-factory-1",
      reservationId: "reservation-factory-1",
      paymentUrl: "https://payments.example.test/factory-1",
      status: "succeeded",
      statusDeliveries: [
        {
          deliveryId: "delivery-factory-1",
          status: "succeeded",
          deliveredAt: "2026-07-15T00:00:00.000Z",
          payload: {
            orderId: "order-factory-1",
            paymentId: "payment-factory-1",
            transactionId: "transaction-factory-1",
            paymentStatus: "succeeded",
          },
        },
      ],
    },
    transaction: {
      transactionId: "transaction-factory-1",
      orderId: "order-factory-1",
      paymentId: "payment-factory-1",
      reservationId: "reservation-factory-1",
      status: "succeeded",
    },
    vendingCommand: {
      commandId: "command-factory-1",
      orderId: "order-factory-1",
      transactionId: "transaction-factory-1",
      status: "succeeded",
      creationCount: 1,
    },
    stockMovement: {
      movementId: "movement-factory-1",
      orderId: "order-factory-1",
      transactionId: "transaction-factory-1",
      commandId: "command-factory-1",
      quantity: -1,
      status: "accepted",
      creationCount: 1,
    },
    fulfillment: {
      status: "succeeded",
      orderId: "order-factory-1",
      transactionId: "transaction-factory-1",
      commandId: "command-factory-1",
      stockMovementId: "movement-factory-1",
    },
  };
}

function saleScenario(input, _runtimeDigest) {
  return {
    schemaVersion: "installed-kiosk-sale-acceptance/v2",
    kind: "installed-kiosk-sale-acceptance",
    status: "passed",
    ok: true,
    runId: input.runId,
    profile: "factory-route-competition",
    runtimeBinding: {
      normal: {
        normalTargetId: "machine-ui-cdp-target-1",
        sessionUser: "VEMKiosk",
        sessionId: 1,
        url: "http://tauri.localhost/#/sale",
        route: "#/sale",
      },
      prelaunch: {
        processId: 4241,
        executablePath: "C:\\VEM\\bringup\\machine.exe",
        sessionId: 1,
        principal: "VEM\\VEMKiosk",
      },
      debug: {
        targetId: "machine-ui-cdp-debug-target-2",
        targetUrl: "http://tauri.localhost/#/catalog",
        machine: {
          processId: 4242,
          executablePath: "C:\\VEM\\bringup\\machine.exe",
          sessionId: 1,
          principal: "VEM\\VEMKiosk",
        },
      },
    },
    machineUiCdpScenario: {
      schemaVersion: "machine-ui-cdp-sale-scenario/v3",
      status: "passed",
      sequenceName: "factory-installed-kiosk-sale",
      target: {
        id: "machine-ui-cdp-debug-target-2",
        route: "#/catalog",
        attestation: {
          expected: {
            targetId: "machine-ui-cdp-debug-target-2",
            machine: {
              processId: 4242,
              executablePath: "C:\\VEM\\bringup\\machine.exe",
              sessionId: 1,
              principal: "VEM\\VEMKiosk",
            },
          },
          observed: {
            machine: {
              processId: 4242,
              executablePath: "C:\\VEM\\bringup\\machine.exe",
              sessionId: 1,
              principal: "VEM\\VEMKiosk",
            },
            cdpListener: {
              processId: 5151,
              executablePath: "C:\\Program Files\\WebView\\msedgewebview2.exe",
              sessionId: 1,
              principal: "VEM\\VEMKiosk",
              machineAncestorProcessId: 4242,
              localAddress: "127.0.0.1",
              localPort: 9222,
            },
            cdpTarget: {
              id: "machine-ui-cdp-debug-target-2",
              url: "http://tauri.localhost/#/catalog",
              route: "#/catalog",
            },
          },
        },
      },
      execution: {
        planned: { customerActivations: 1, observations: 1, routeActions: 1 },
        executed: { customerActivations: 1, observations: 1, routeActions: 1 },
      },
      evidence: [
        {
          type: "customer-activation",
          label: "start-sale",
          selector: "[data-testid='start-sale']",
          input: {
            method: "Input.dispatchTouchEvent",
            kind: "touch",
            x: 10,
            y: 20,
            released: true,
          },
          routeBefore: "#/catalog",
        },
        {
          type: "route-barrier",
          label: "payment option",
          forbiddenRoutes: ["/catalog", "/home", "/maintenance"],
        },
        {
          type: "route-action",
          label: "catalog competition during payment",
          attemptRoute: "#/catalog",
          routeBefore: "#/payment",
          routeReportedByHook: "#/payment",
        },
        {
          type: "checkpoint",
          label: "continuous",
          identity: {
            url: "http://tauri.localhost/#/payment",
            route: "#/payment",
          },
        },
        {
          type: "observation",
          label: "result",
          identity: {
            url: "http://tauri.localhost/#/result",
            route: "#/result",
          },
        },
      ],
    },
    correlation: {
      saleCorrelationId: `sale-correlation://factory-${input.runId.toLowerCase()}`,
      rendered: {
        orderId: "order-factory-1",
        paymentId: "payment-factory-1",
        transactionId: "transaction-factory-1",
        commandId: "command-factory-1",
      },
      platform: {
        orderId: "order-factory-1",
        paymentId: "payment-factory-1",
        transactionId: "transaction-factory-1",
        commandId: "command-factory-1",
        stockMovementId: "movement-factory-1",
        stockDelta: -1,
        status: "accepted",
        observations: {
          orderIds: {
            occurrences: ["order-factory-1", "order-factory-1"],
            unique: ["order-factory-1"],
            count: 1,
          },
          paymentIds: {
            occurrences: ["payment-factory-1"],
            unique: ["payment-factory-1"],
            count: 1,
          },
          transactionIds: {
            occurrences: ["transaction-factory-1"],
            unique: ["transaction-factory-1"],
            count: 1,
          },
          commandIds: {
            occurrences: ["command-factory-1", "command-factory-1"],
            unique: ["command-factory-1"],
            count: 1,
          },
          movementIds: {
            occurrences: ["movement-factory-1"],
            unique: ["movement-factory-1"],
            count: 1,
          },
        },
      },
      serial: {
        collected: {
          orderId: "order-factory-1",
          paymentId: "payment-factory-1",
          vendingCommandId: "command-factory-1",
        },
      },
      exactOnce: {
        orderCount: 1,
        paymentCount: 1,
        commandCount: 1,
        movementCount: 1,
        stockDelta: -1,
        serialSaleBindingCount: { injected: 1, collected: 1 },
      },
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
    const endpoint = overlayEndpoint(input);
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

  it("runs one installed customer UI sale after runtime acceptance and before display capture", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-sale-command-"));
    const input = typedInput(root);
    const endpoint = overlayEndpoint(input);
    const sshKnownHostsPath = join(root, "lifecycle-known-hosts");
    const invocation = buildFactoryInstalledKioskSaleInvocation(
      input,
      endpoint,
      runtimeAcceptanceSummary(),
      sshKnownHostsPath,
    );

    assert.deepEqual(invocation.slice(0, 2), [
      "node",
      "scripts/testbed/installed-kiosk-sale-acceptance.mjs",
    ]);
    assert.equal(
      invocation[invocation.indexOf("--out") + 1],
      join(input.evidence.root, "verifier", "customer-ui-sale-scenario.json"),
    );
    assert.equal(
      invocation[invocation.indexOf("--runtime-acceptance-report") + 1],
      join(input.evidence.root, "verifier", "runtime-acceptance.json"),
    );
    assert.equal(
      invocation[invocation.indexOf("--target-identity") + 1],
      input.targetIdentity,
    );
    assert.equal(
      invocation[invocation.indexOf("--approved-runtime-base") + 1],
      input.factory.isoIdentity,
    );
    assert.equal(
      invocation[invocation.indexOf("--profile") + 1],
      "factory-route-competition",
    );
    assert.equal(
      invocation[invocation.indexOf("--ssh-known-hosts-path") + 1],
      sshKnownHostsPath,
    );
    const dryRun = spawnSync(
      invocation[0],
      [...invocation.slice(1), "--dry-run"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(
      plan.interface,
      "installed-kiosk-sale-acceptance",
      "Factory invocation must execute against the callable host CLI",
    );
    assert.equal(plan.profile, "factory-route-competition");
    assert.equal(
      plan.artifacts.report,
      join(input.evidence.root, "verifier", "customer-ui-sale-scenario.json"),
    );
  });

  it("requires the installed kiosk sale scenario to bind UI, runtime, hardware, and stock evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-sale-report-"));
    const input = typedInput(root);
    const digest = writeRuntimeAcceptanceVerifier(input);
    const output = join(
      input.evidence.root,
      "verifier",
      "customer-ui-sale-scenario.json",
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(saleScenario(input, digest))}\n`);

    assert.deepEqual(
      verifyInstalledKioskSaleScenarioResult(
        output,
        input,
        runtimeAcceptanceSummary(),
      ),
      {
        status: "passed",
        schemaVersion: "installed-kiosk-sale-acceptance/v2",
        target: {
          id: "machine-ui-cdp-debug-target-2",
          route: "#/catalog",
          sessionUser: "VEMKiosk",
          sessionId: 1,
        },
        linkedSale: {
          orderId: "order-factory-1",
          paymentId: "payment-factory-1",
          transactionId: "transaction-factory-1",
          commandId: "command-factory-1",
          stockMovementId: "movement-factory-1",
        },
        routeCompetitionCase: "catalog_during_payment",
      },
    );

    const missingInput = saleScenario(input, digest);
    missingInput.machineUiCdpScenario.evidence[0].input.method =
      "HTMLElement.click";
    writeFileSync(output, `${JSON.stringify(missingInput)}\n`);
    assert.throws(
      () =>
        verifyInstalledKioskSaleScenarioResult(
          output,
          input,
          runtimeAcceptanceSummary(),
        ),
      /physical Input/,
    );

    const wrongStock = saleScenario(input, digest);
    wrongStock.correlation.platform.stockDelta = 0;
    writeFileSync(output, `${JSON.stringify(wrongStock)}\n`);
    assert.throws(
      () =>
        verifyInstalledKioskSaleScenarioResult(
          output,
          input,
          runtimeAcceptanceSummary(),
        ),
      /rendered payment, serial command, and stock movement/,
    );
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
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true},"oobeComplete":{"asserted":true,"cleanupPhase":"complete","cleanupTaskPresent":false,"postRebootBootIdentityChanged":true,"activeVemKioskConsoleSession":true}}}'
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
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true},"oobeComplete":{"asserted":true,"cleanupPhase":"complete","cleanupTaskPresent":false,"postRebootBootIdentityChanged":true,"activeVemKioskConsoleSession":true}}}'
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

  it("rejects adapter-attested relay state before any adapter operation", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-image-relay-proof-"));
    const input = typedInput(root);
    const inputPath = join(root, "input.json");
    const adapterLog = join(root, "adapter-operations.log");
    input.maintenanceRelayAttestation.source = "adapter";
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
          VEM_VM_HOST_ADAPTER_OPERATION_LOG: adapterLog,
          VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID: `factory-cas://sha256/${"d".repeat(64)}`,
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /runner-owned/i);
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
attempt_file=${join(root, "ssh-attempts")}
attempt=0
if [ -f "$attempt_file" ]; then attempt=$(cat "$attempt_file"); fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$attempt_file"
if [ "$attempt" -eq 1 ]; then
  printf '%s\\n' 'Connection reset by peer during Factory reboot' >&2
  exit 255
fi
printf '%s\\n' "$@" > ${join(root, "ssh-args.txt")}
cat > ${join(root, "ssh-stdin.ps1")}
printf '%s\\n' '{"schemaVersion":"factory-preclaim-verification/v1","kind":"factory-preclaim-verification","runId":"RUN-15-LIFECYCLE","expectedUnclaimedMachineCode":"VEM-TESTBED-WINVM-01","readOnly":true,"ok":true,"checks":{"factoryRuntime":{"ok":true},"absentMachineIdentity":{"asserted":true},"oobeComplete":{"asserted":true,"cleanupPhase":"complete","cleanupTaskPresent":false,"postRebootBootIdentityChanged":true,"activeVemKioskConsoleSession":true}}}'
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
      assert.equal(
        readFileSync(join(root, "ssh-attempts"), "utf8"),
        "2",
        "factory preclaim must retry a transient reboot transport disconnect",
      );
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
