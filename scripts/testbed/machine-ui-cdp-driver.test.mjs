import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildInstalledKioskSaleScenarioSteps } from "./installed-kiosk-sale-acceptance.mjs";
import {
  CdpClient,
  activateVisibleSelector,
  assertTargetDebuggerWebSocketUrl,
  captureScreenshot,
  bindMachineUiRuntimeEvidence,
  buildWindowsMachineUiInspectionScript,
  discoverCanonicalMachineUiTarget,
  discoverMachineUiTarget,
  inspectWindowsMachineUiRuntimeForTest,
  normalizeMachineRoute,
  openMachineUiCdpSidecar,
  rewriteWebSocketDebuggerUrl,
  runVisibleMachineSaleScenario,
  runVisibleMachineSaleScenarioForTest,
  runWindowsPowerShellOverSshForTest,
  startContinuousIdentityCapture,
} from "./machine-ui-cdp-driver.mjs";

const ATTESTATION = {
  targetId: "machine-target",
  machine: {
    processId: 4242,
    executablePath: "C:\\VEM\\bringup\\machine.exe",
    sessionId: 1,
    principal: "VEM\\VEMKiosk",
  },
};

const OBSERVED_RUNTIME = {
  machine: {
    processId: 4242,
    executablePath: "C:\\VEM\\bringup\\machine.exe",
    sessionId: 1,
    principal: "VEM\\VEMKiosk",
  },
  cdpListener: {
    processId: 5151,
    executablePath:
      "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe",
    sessionId: 1,
    principal: "VEM\\VEMKiosk",
    machineAncestorProcessId: 4242,
    localAddress: "127.0.0.1",
    localPort: 9222,
  },
};

function acceptanceAdapter(overrides = {}) {
  return overrides;
}

async function fakeWindowsCommandRunner() {
  return OBSERVED_RUNTIME;
}

function runScenarioForTest(options) {
  const {
    webSocketFactory,
    remoteCommandRunner = fakeWindowsCommandRunner,
    ...scenarioOptions
  } = options;
  return runVisibleMachineSaleScenarioForTest(scenarioOptions, {
    webSocketFactory,
    remoteCommandRunner,
  });
}

async function runInstalledRouteCompetitionScenario({
  competingRoute = null,
  touchIntervalRoute = null,
  onPaymentWindow,
} = {}) {
  return withFakeHttpTargets(
    [target("machine-target", "#/catalog")],
    async (endpoint) => {
      let route = "#/catalog";
      let activations = 0;
      let disturbanceCount = 0;
      let externalOperation = null;
      let cdpSocket;
      const setRoute = (nextRoute) => {
        route = nextRoute;
        cdpSocket.emitMessage({
          method: "Page.navigatedWithinDocument",
          params: { url: `http://tauri.localhost/${route}` },
        });
      };
      const { factory, sockets } = createFakeWebSocketFactory(
        (message, socket) => {
          cdpSocket = socket;
          if (message.method === "Runtime.evaluate") {
            const expression = message.params.expression;
            if (expression.includes("catalogRequests")) {
              const catalogRevision = "a".repeat(64);
              const catalogInvalidationId = `catalog-invalidation:guest-catalog_projection_refresh:${catalogRevision}`;
              return cdpValue(
                {
                  runtimeTrace:
                    externalOperation === "vision_departure"
                      ? [
                          {
                            type: "navigation",
                            intentType: "presence.departed",
                            sourceEventId: "vision-event-test",
                          },
                        ]
                      : [],
                  catalogRequests:
                    externalOperation === "catalog_projection_refresh"
                      ? ["http://127.0.0.1/v1/catalog"]
                      : [],
                  catalogRevision:
                    externalOperation === "catalog_projection_refresh"
                      ? catalogRevision
                      : null,
                  catalogInvalidationId:
                    externalOperation === "catalog_projection_refresh"
                      ? catalogInvalidationId
                      : null,
                  recoveryOverlay: [],
                  orderCredential: "ORDER-TEST",
                  route,
                },
                message.id,
              );
            }
            if (expression.includes("getBoundingClientRect")) {
              return cdpValue(
                {
                  selector: "[data-test]",
                  actionable: true,
                  inViewport: true,
                  pointerEvents: "auto",
                  hitTarget: true,
                  bounds: { x: 0, y: 0, width: 10, height: 10 },
                  center: { x: 5, y: 5 },
                },
                message.id,
              );
            }
            if (expression.includes("history.back()")) {
              assert.doesNotMatch(expression, /location\.hash\s*=/);
              const routeBefore = route;
              if (competingRoute) {
                setRoute(competingRoute);
              }
              return cdpValue(
                { stimulus: "history-back", routeBefore },
                message.id,
              );
            }
            if (expression.includes("__VEM_INSTALLED_KIOSK_SALE_DEBUG__")) {
              disturbanceCount += 1;
              if (disturbanceCount === 1) {
                return cdpValue(
                  {
                    injectionId: "browser-injection-presence-1",
                    kind: "presence_departure",
                    count: 1,
                    outcome: "completed",
                  },
                  message.id,
                );
              }
              return cdpValue(
                {
                  injectionId: "browser-injection-catalog-1",
                  kind: "catalog_refresh",
                  count: 1,
                  outcome: "completed",
                  pressure: {
                    refreshedState: "catalog",
                    attemptedRoute: "/catalog",
                    resolvedRoute: "/payment",
                    routeAuthorityWon: true,
                  },
                },
                message.id,
              );
            }
            return cdpValue(identity(route), message.id);
          }
          if (
            message.method === "Input.dispatchTouchEvent" &&
            message.params.type === "touchStart"
          ) {
            activations += 1;
            const nextRoute = [
              "#/catalog",
              "#/products/test-item",
              "#/checkout",
              "#/checkout",
              "#/checkout",
              "#/payment",
            ][activations - 1];
            if (nextRoute !== route) {
              route = nextRoute;
              socket.emitMessage({
                method: "Page.navigatedWithinDocument",
                params: { url: `http://tauri.localhost/${route}` },
              });
            }
            if (activations === 6 && touchIntervalRoute) {
              setRoute(touchIntervalRoute);
            }
          }
          if (
            message.method === "Input.dispatchTouchEvent" &&
            message.params.type === "touchEnd" &&
            activations === 6 &&
            touchIntervalRoute === "#/checkout"
          ) {
            setRoute("#/payment");
          }
          if (message.method === "Page.captureScreenshot") {
            return {
              id: message.id,
              result: { data: Buffer.from("png").toString("base64") },
            };
          }
          return { id: message.id, result: {} };
        },
      );
      const result = await runScenarioForTest({
        endpoint,
        tunnelOptions: { remote: "test@win10.test" },
        expectedRuntimeAttestation: ATTESTATION,
        expectedInitialRoute: "#/catalog",
        sequenceName: "installed-route-competition",
        steps: buildInstalledKioskSaleScenarioSteps("vm-route-competition"),
        adapter: {
          async executeExternalOperation({ operation }) {
            externalOperation = operation;
            const catalogRevision = "a".repeat(64);
            return {
              operation,
              guestOperationId: `guest-${operation}`,
              adapterSessionId: "serial-session-test",
              session: {
                daemonReadyFile: "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
                daemonEndpoint: "http://127.0.0.1:7615",
              },
              daemon: {
                transactionBefore: { orderNo: "ORDER-TEST" },
                transactionAfter: { orderNo: "ORDER-TEST" },
                runtimeTrace: { eventId: "vision-event-test" },
                catalog: {
                  revision:
                    operation === "catalog_projection_refresh"
                      ? catalogRevision
                      : null,
                  invalidationId:
                    operation === "catalog_projection_refresh"
                      ? `catalog-invalidation:guest-catalog_projection_refresh:${catalogRevision}`
                      : null,
                },
              },
              platform: { orderNo: "ORDER-TEST" },
              log: { collector: "windows_application_log", digest: "b".repeat(64), recordCount: 1 },
              vision: { eventId: "vision-event-test", delivered: true },
            };
          },
        },
        webSocketFactory: factory,
        continuousCapture: true,
        continuousCaptureIntervalMs: 1,
        routePollMs: 1,
        onPaymentWindow:
          typeof onPaymentWindow === "function"
            ? () => onPaymentWindow({ setRoute })
            : undefined,
      });
      return { result, sockets };
    },
  );
}

describe("machine-ui-cdp-driver", () => {
  it("discovers the one expected strict CDP target", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        const selected = await discoverMachineUiTarget({
          endpoint,
          expectedTargetId: ATTESTATION.targetId,
        });
        assert.equal(selected.id, "machine-target");
      },
    );
  });

  it("discovers the canonical target without caller identity and derives the connection session", async () => {
    await withFakeHttpTargets(
      [target("observed-target", "#/catalog")],
      async (endpoint) => {
        const selected = await discoverCanonicalMachineUiTarget({ endpoint });
        assert.equal(selected.id, "observed-target");
      },
    );
    const { factory } = createFakeWebSocketFactory((message) => ({
      id: message.id,
      result: { targetInfo: { targetId: "observed-target" } },
    }));
    const client = new CdpClient(
      "ws://127.0.0.1/devtools/page/observed-target",
      { webSocketFactory: factory },
    );
    await client.connect();
    const identity = await client.observeIdentity();
    assert.equal(identity.targetId, "observed-target");
    assert.match(identity.sessionId, /^cdp-connection:[0-9a-f-]{36}$/);
    assert.match(identity.connectedAt, /\.\d{3}Z$/);
    await client.close();
  });

  it("rejects a debugger websocket pathname that does not exactly bind its target id", async () => {
    assert.throws(
      () =>
        assertTargetDebuggerWebSocketUrl(
          "ws://127.0.0.1:9222/devtools/page/machine-target/extra",
          "machine-target",
        ),
      /pathname does not match target id/,
    );
    await withFakeHttpTargets(
      [
        {
          ...target("machine-target", "#/sale"),
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9222/devtools/page/other-target",
        },
      ],
      async (endpoint) => {
        await assert.rejects(
          discoverMachineUiTarget({
            endpoint,
            expectedTargetId: ATTESTATION.targetId,
          }),
          /pathname does not match target id/,
        );
      },
    );
  });

  for (const [name, targets, binding, pattern] of [
    [
      "zero strict targets",
      [
        {
          id: "devtools",
          url: "devtools://devtools/bundled/inspector.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/devtools",
        },
      ],
      ATTESTATION.targetId,
      /exactly one strict tauri target; found 0/,
    ],
    [
      "multiple strict targets",
      [target("machine-target", "#/sale"), target("stale", "#/checkout")],
      ATTESTATION.targetId,
      /exactly one strict tauri target; found 2/,
    ],
    [
      "a stale target id",
      [target("stale", "#/sale")],
      ATTESTATION.targetId,
      /target binding is stale/,
    ],
    [
      "an incomplete external binding",
      [target("machine-target", "#/sale")],
      "",
      /expectedTargetId is required/,
    ],
  ]) {
    it(`rejects ${name}`, async () => {
      await withFakeHttpTargets(targets, async (endpoint) => {
        await assert.rejects(
          discoverMachineUiTarget({
            endpoint,
            expectedTargetId: binding,
          }),
          pattern,
        );
      });
    });
  }

  it("derives Windows process facts remotely and binds them to the live CDP target", async () => {
    let invocation;
    const observed = await inspectWindowsMachineUiRuntimeForTest(
      {
        remote: "YKDZ@win10.test",
        expectedMachinePath: ATTESTATION.machine.executablePath,
      },
      {
        commandRunner: async (input) => {
          invocation = input;
          return OBSERVED_RUNTIME;
        },
      },
    );
    const evidence = bindMachineUiRuntimeEvidence({
      expectedRuntimeAttestation: ATTESTATION,
      observedRuntime: observed,
      target: target("machine-target", "#/checkout?b=2&a=1"),
    });

    assert.equal(invocation.remote, "YKDZ@win10.test");
    assert.match(invocation.script, /Get-NetTCPConnection/);
    assert.match(invocation.script, /Win32_Process/);
    assert.match(invocation.script, /GetOwner/);
    assert.match(invocation.script, /machineOwner\.Domain/);
    assert.match(invocation.script, /listenerOwner\.Domain/);
    assert.equal(evidence.observed.machine.processId, 4242);
    assert.equal(evidence.observed.cdpTarget.route, "#/checkout?a=1&b=2");
  });

  it("passes known-host trust options through runtime inspection and its SSH command", async () => {
    let inspectionInvocation;
    await inspectWindowsMachineUiRuntimeForTest(
      {
        remote: "YKDZ@win10.test",
        expectedMachinePath: ATTESTATION.machine.executablePath,
        sshKnownHostsPath: "/tmp/vem-known-hosts",
        sshHostKeyAlias: "vem-factory-run-180",
      },
      {
        commandRunner: async (input) => {
          inspectionInvocation = input;
          return OBSERVED_RUNTIME;
        },
      },
    );
    assert.equal(
      inspectionInvocation.sshKnownHostsPath,
      "/tmp/vem-known-hosts",
    );
    assert.equal(inspectionInvocation.sshHostKeyAlias, "vem-factory-run-180");

    const child = new FakeChildProcess();
    let args;
    const inspectionScript = buildWindowsMachineUiInspectionScript({
      machinePath: ATTESTATION.machine.executablePath,
      remoteCdpPort: 9222,
    });
    const command = runWindowsPowerShellOverSshForTest(
      {
        remote: "YKDZ@win10.test",
        sshKnownHostsPath: "/tmp/vem-known-hosts",
        sshHostKeyAlias: "vem-factory-run-180",
        script: inspectionScript,
      },
      {
        processAdapter: {
          spawn(_command, receivedArgs) {
            args = receivedArgs;
            queueMicrotask(() => {
              child.stdout.emit("data", JSON.stringify(OBSERVED_RUNTIME));
              child.finish(0, null);
            });
            return child;
          },
        },
      },
    );
    await command;
    assert.deepEqual(args.slice(0, 6), [
      "-o",
      "BatchMode=yes",
      "-o",
      "UserKnownHostsFile=/tmp/vem-known-hosts",
      "-o",
      "HostKeyAlias=vem-factory-run-180",
    ]);
    assert.equal(args.at(-2), "-EncodedCommand");
    assert.equal(
      Buffer.from(args.at(-1), "base64").toString("utf16le"),
      inspectionScript,
    );
    assert.ok(
      `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${args.at(-1)}`
        .length < 8191,
    );
  });

  for (const [name, mutate, pattern] of [
    [
      "a caller PID that does not match the remotely observed process",
      (attestation) => {
        attestation.machine.processId = 99;
      },
      /machine process processId mismatch/,
    ],
    [
      "a listener outside the machine session",
      (_attestation, observed) => {
        observed.cdpListener.sessionId = 2;
      },
      /listener session does not match/,
    ],
    [
      "a listener principal that differs only by case",
      (_attestation, observed) => {
        observed.cdpListener.principal = "VEM\\vemkiosk";
      },
      /listener principal does not match/,
    ],
    [
      "a CDP target that differs from the expected target",
      (attestation) => {
        attestation.targetId = "other-target";
      },
      /CDP target id mismatch/,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const attestation = structuredClone(ATTESTATION);
      const observed = structuredClone(OBSERVED_RUNTIME);
      mutate(attestation, observed);
      assert.throws(
        () =>
          bindMachineUiRuntimeEvidence({
            expectedRuntimeAttestation: attestation,
            observedRuntime: observed,
            target: target("machine-target", "#/checkout"),
          }),
        pattern,
      );
    });
  }

  it("normalizes hashes, paths, and query order before route checks", () => {
    assert.equal(
      normalizeMachineRoute("#/maintenance?z=3&a=1"),
      "#/maintenance?a=1&z=3",
    );
    assert.equal(normalizeMachineRoute("#/products/../catalog"), "#/catalog");
    assert.equal(
      normalizeMachineRoute("#/MAINTENANCE%2Flogs"),
      "#/maintenance/logs",
    );
  });

  it("requires exact Domain\\User principals in runtime attestation", () => {
    const attestation = structuredClone(ATTESTATION);
    attestation.machine.principal = "VEMKiosk";
    assert.throws(
      () =>
        bindMachineUiRuntimeEvidence({
          expectedRuntimeAttestation: attestation,
          observedRuntime: OBSERVED_RUNTIME,
          target: target("machine-target", "#/sale"),
        }),
      /exact Domain\\User/,
    );
  });

  it("rewrites ws/wss debugger URLs, including an IPv6 forward", () => {
    assert.equal(
      rewriteWebSocketDebuggerUrl(
        "ws://127.0.0.1:9222/devtools/page/ABC?token=remote",
        "http://[::1]:49152",
      ),
      "ws://[::1]:49152/devtools/page/ABC?token=remote",
    );
    assert.equal(
      rewriteWebSocketDebuggerUrl(
        "wss://remote.test/devtools/page/ABC",
        "https://127.0.0.1:49153",
      ),
      "wss://127.0.0.1:49153/devtools/page/ABC",
    );
    assert.throws(
      () =>
        rewriteWebSocketDebuggerUrl(
          "http://127.0.0.1/devtools/page/ABC",
          "http://127.0.0.1:49152",
        ),
      /must use ws or wss/,
    );
  });

  it("rejects production acceptance transport injection before it can run", async () => {
    await assert.rejects(
      runVisibleMachineSaleScenario({ endpoint: "http://127.0.0.1:9222" }),
      /endpoint is test-only/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({ remoteCommandRunner() {} }),
      /remoteCommandRunner is test-only/,
    );
    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./machine-ui-cdp-driver.mjs", import.meta.url)),
        "--endpoint",
        "http://127.0.0.1:9222",
      ],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /unknown argument: --endpoint/);
  });

  it("rejects nested production tunnel injection before it can run", async () => {
    await assert.rejects(
      runVisibleMachineSaleScenario({
        tunnelOptions: {
          remote: "test@win10.test",
          endpoint: "http://127.0.0.1:9222",
        },
      }),
      /tunnelOptions\.endpoint is not allowed/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({
        tunnelOptions: {
          remote: "test@win10.test",
          processAdapter: {
            spawn() {
              throw new Error("injected adapter must not run");
            },
          },
        },
      }),
      /tunnelOptions\.processAdapter is not allowed/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({
        tunnelOptions: {
          remote: "test@win10.test",
          remoteCdpHost: "attacker.example",
        },
      }),
      /tunnelOptions\.remoteCdpHost is not allowed/,
    );
  });

  it("opens an SSH tunnel only after readiness and drains stderr", async () => {
    const child = new FakeChildProcess();
    let ready = false;
    const sidecar = await openMachineUiCdpSidecar({
      remote: "user@example.test",
      localPort: 49222,
      sshKnownHostsPath: "/tmp/vem-known-hosts",
      sshHostKeyAlias: "vem-factory-run-180",
      processAdapter: {
        spawn(command, args, options) {
          child.command = command;
          child.args = args;
          child.options = options;
          return child;
        },
        async waitForReady(details) {
          assert.equal(details.endpoint, "http://127.0.0.1:49222");
          child.stderr.emit("data", "ssh diagnostic");
          ready = true;
        },
      },
    });

    assert.equal(ready, true);
    assert.equal(child.stderr.resumed, true);
    assert.deepEqual(child.args, [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "127.0.0.1:49222:127.0.0.1:9222",
      "-o",
      "UserKnownHostsFile=/tmp/vem-known-hosts",
      "-o",
      "HostKeyAlias=vem-factory-run-180",
      "user@example.test",
    ]);
    const closing = sidecar.close();
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(child.exitCode, null);
    child.finish(0, "SIGTERM");
    await closing;
  });

  it("rejects non-loopback tunnel destinations before spawning SSH", async () => {
    await assert.rejects(
      openMachineUiCdpSidecar({
        remote: "user@example.test",
        remoteCdpHost: "10.0.0.15",
        processAdapter: {
          spawn() {
            throw new Error("must not spawn");
          },
        },
      }),
      /remote CDP tunnel host must be inspected loopback/,
    );
  });

  it("rejects child process spawn errors and exits before readiness", async () => {
    await assert.rejects(
      openMachineUiCdpSidecar({
        remote: "user@example.test",
        localPort: 49223,
        processAdapter: {
          spawn() {
            throw new Error("ENOENT");
          },
        },
      }),
      /SSH tunnel spawn failed: ENOENT/,
    );

    const child = new FakeChildProcess();
    const opening = openMachineUiCdpSidecar({
      remote: "user@example.test",
      localPort: 49224,
      processAdapter: {
        spawn() {
          queueMicrotask(() => {
            child.stderr.emit("data", "bind failed");
            child.finish(255, null);
          });
          return child;
        },
        waitForReady() {
          return new Promise(() => {});
        },
      },
    });
    await assert.rejects(opening, /exited before readiness.*bind failed/);
  });

  it("uses browser WebSocket semantics and cleans up synchronous send throws", async () => {
    assert.throws(
      () =>
        new CdpClient("http://127.0.0.1/devtools/page/1", {
          webSocketFactory: () => ({}),
        }),
      /must use ws or wss/,
    );
    const { factory, sockets } = createFakeWebSocketFactory(() => null);
    const client = new CdpClient("ws://127.0.0.1/devtools/page/1", {
      webSocketFactory: factory,
    });
    await client.connect();
    sockets[0].sendError = new Error("socket write failed");
    await assert.rejects(client.send("Runtime.evaluate"), /send failed/);
    assert.equal(client.pending.size, 0);
    await client.close();

    const emitterClient = new CdpClient("ws://127.0.0.1/devtools/page/2", {
      webSocketFactory: () => new EventEmitter(),
    });
    await assert.rejects(
      emitterClient.connect(),
      /browser WebSocket EventTarget interface/,
    );
  });

  it("times out requests and awaits WebSocket close", async () => {
    const { factory, sockets } = createFakeWebSocketFactory(() => null, {
      autoClose: false,
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/timeout", {
      webSocketFactory: factory,
      defaultTimeoutMs: 50,
    });
    await client.connect();
    await assert.rejects(
      client.send("Runtime.evaluate", {}, { timeoutMs: 5 }),
      /timed out/,
    );
    assert.equal(client.pending.size, 0);
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    sockets[0].finishClose();
    await closing;
    assert.equal(closed, true);
  });

  it("dispatches only physically actionable touch input and always ends it", async () => {
    const { factory, sockets } = createFakeWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        return cdpValue(
          {
            selector: "[data-testid='buy']",
            exists: true,
            actionable: true,
            inViewport: true,
            pointerEvents: "auto",
            hitTarget: true,
            bounds: { x: 10, y: 20, width: 40, height: 60 },
            center: { x: 30, y: 50 },
          },
          message.id,
        );
      }
      if (
        message.method === "Input.dispatchTouchEvent" &&
        message.params.type === "touchStart"
      ) {
        return { id: message.id, error: { message: "press failed" } };
      }
      return { id: message.id, result: {} };
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/1", {
      webSocketFactory: factory,
    });
    await client.connect();
    await assert.rejects(
      activateVisibleSelector(client, "[data-testid='buy']"),
      /press failed/,
    );
    assert.deepEqual(
      sockets[0].sent.map((message) => [message.method, message.params.type]),
      [
        ["Runtime.evaluate", undefined],
        ["Input.dispatchTouchEvent", "touchStart"],
        ["Input.dispatchTouchEvent", "touchEnd"],
      ],
    );
    assert.doesNotMatch(sockets[0].sent[0].params.expression, /\.click\s*\(/);
    await client.close();
  });

  it("waits for an asynchronously enabled physical action", async () => {
    let probes = 0;
    const { factory } = createFakeWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        probes += 1;
        return cdpValue(
          probes === 1
            ? { selector: "#submit", exists: true, actionable: false }
            : {
                selector: "#submit",
                exists: true,
                actionable: true,
                bounds: { x: 0, y: 0, width: 20, height: 20 },
                center: { x: 10, y: 10 },
              },
          message.id,
        );
      }
      return { id: message.id, result: {} };
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/async", {
      webSocketFactory: factory,
    });
    await client.connect();
    await activateVisibleSelector(client, "#submit", {
      timeoutMs: 100,
      pollMs: 1,
    });
    assert.equal(probes, 2);
    await client.close();
  });

  it("rejects off-viewport, pointer-disabled, or occluded selectors", async () => {
    for (const probe of [
      {
        actionable: false,
        inViewport: false,
        pointerEvents: "auto",
        hitTarget: true,
      },
      {
        actionable: false,
        inViewport: true,
        pointerEvents: "none",
        hitTarget: true,
      },
      {
        actionable: false,
        inViewport: true,
        pointerEvents: "auto",
        hitTarget: false,
      },
    ]) {
      const { factory, sockets } = createFakeWebSocketFactory((message) =>
        cdpValue({ selector: "#buy", exists: true, ...probe }, message.id),
      );
      const client = new CdpClient("ws://127.0.0.1/devtools/page/probe", {
        webSocketFactory: factory,
      });
      await client.connect();
      await assert.rejects(
        activateVisibleSelector(client, "#buy"),
        /not physically actionable/,
      );
      assert.deepEqual(
        sockets[0].sent.map((message) => message.method),
        ["Runtime.evaluate"],
      );
      await client.close();
    }
  });

  it("requires a named nonempty sale sequence with customer routes and actions", async () => {
    const common = {
      expectedRuntimeAttestation: ATTESTATION,
      expectedInitialRoute: "#/sale",
    };
    await assert.rejects(
      runVisibleMachineSaleScenario({ ...common, sequenceName: "", steps: [] }),
      /sequenceName is required/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({
        ...common,
        sequenceName: "sale",
        steps: [],
      }),
      /nonempty step sequence/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({
        ...common,
        sequenceName: "sale",
        steps: [{ type: "infrastructure", name: "look" }],
      }),
      /unsupported step type infrastructure/,
    );
    await assert.rejects(
      runVisibleMachineSaleScenario({
        ...common,
        sequenceName: "sale",
        steps: [
          {
            type: "customer-activation",
            name: "buy",
            selector: "#buy",
            routeBefore: "#/sale",
            routeAfter: "#/checkout",
            action() {},
          },
        ],
      }),
      /unsupported field action/,
    );
  });

  it("executes the exact installed route-competition scenario with RegExp matchers", async () => {
    const { result, sockets } = await runInstalledRouteCompetitionScenario();

    assert.deepEqual(result.execution, {
      planned: { customerActivations: 6, observations: 0, externalOperations: 2 },
      executed: { customerActivations: 6, observations: 0, externalOperations: 2 },
    });
    assert.ok(
      result.evidence.some(
        (entry) =>
          entry.type === "external-operation" &&
          entry.operation === "vision_departure" &&
          entry.routeBefore === "#/payment" &&
          entry.routeAfter === "#/payment" &&
          entry.provenance.guestOperationId === "guest-vision_departure",
      ),
    );
    const barrier = result.evidence.find(
      (entry) => entry.type === "route-barrier",
    );
    assert.equal(barrier.armedBeforeInput, true);
    assert.equal(barrier.armBaseline.route, "#/checkout");
    const paymentActivation = result.evidence.find(
      (entry) =>
        entry.type === "customer-activation" &&
        entry.label === "payment submit repeat",
    );
    assert.equal(paymentActivation.routeBefore, "#/checkout");
  });

  it("records a timer checkpoint strictly during injected serial completion", async () => {
    let paymentWindowCalls = 0;
    let serialTimerTicks = 0;
    const { result } = await runInstalledRouteCompetitionScenario({
      onPaymentWindow: async () => {
        paymentWindowCalls += 1;
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            serialTimerTicks += 1;
            if (serialTimerTicks === 3) {
              clearInterval(timer);
              resolve();
            }
          }, 1);
        });
        return { serialCompleted: true, postSaleStable: true };
      },
    });

    assert.equal(paymentWindowCalls, 1);
    assert.ok(serialTimerTicks >= 3);
    assert.ok(
      result.evidence.some(
        (entry) =>
          entry.type === "payment-window" &&
          entry.serialCompleted === true &&
          entry.postSaleStable === true,
      ),
    );
    const paymentWindow = result.evidence.find(
      (entry) => entry.type === "payment-window",
    );
    const [before, during, after] = paymentWindow.continuousCheckpointOrdinals;
    assert.ok(before < during && during < after);
    assert.ok(
      result.evidence.some(
        (entry) =>
          entry.type === "checkpoint" &&
          entry.label === "continuous" &&
          entry.ordinal === during,
      ),
    );
  });

  it("accepts a terminal result's automatic catalog return without bypassing payment completion", async () => {
    const { result } = await runInstalledRouteCompetitionScenario({
      onPaymentWindow: async ({ setRoute }) => {
        setRoute("#/result");
        await sleep(3);
        setRoute("#/catalog");
        await sleep(3);
        return { serialCompleted: true, postSaleStable: true };
      },
    });

    assert.ok(
      result.evidence.some(
        (entry) =>
          entry.type === "payment-window" &&
          entry.serialCompleted === true &&
          entry.postSaleStable === true,
      ),
    );
  });

  for (const rejectedRoute of ["#/", "#/maintenance", "#/orders/other-order"]) {
    it(`rejects ${rejectedRoute} before a terminal payment result`, async () => {
      await assert.rejects(
        runInstalledRouteCompetitionScenario({
          onPaymentWindow: async ({ setRoute }) => {
            setRoute(rejectedRoute);
            return { serialCompleted: true, postSaleStable: true };
          },
        }),
        new RegExp(`payment barrier route observed: ${rejectedRoute}`),
      );
    });
  }

  it("allows checkout while payment submission is creating the first order", async () => {
    const { result } = await runInstalledRouteCompetitionScenario({
      touchIntervalRoute: "#/checkout",
    });
    assert.equal(result.status, "passed");
  });

  it("rejects a product route injected between payment touch start and end", async () => {
    await assert.rejects(
      runInstalledRouteCompetitionScenario({
        touchIntervalRoute: "#/products/test-item",
      }),
      /payment barrier route observed: #\/products\/test-item/,
    );
  });

  it("records Input evidence and bounded chronological checkpoints", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        let route = "#/sale";
        const screenshotBytes = Buffer.from("fake-png");
        const { factory, sockets } = createFakeWebSocketFactory(
          (message, socket) => {
            if (message.method === "Runtime.evaluate") {
              if (message.params.expression.includes("querySelector")) {
                return cdpValue(
                  {
                    selector: "#buy",
                    exists: true,
                    actionable: true,
                    inViewport: true,
                    pointerEvents: "auto",
                    hitTarget: true,
                    bounds: { x: 1, y: 2, width: 10, height: 20 },
                    center: { x: 6, y: 12 },
                  },
                  message.id,
                );
              }
              return cdpValue(identity(route), message.id);
            }
            if (
              message.method === "Input.dispatchTouchEvent" &&
              message.params.type === "touchStart"
            ) {
              route = "#/checkout";
              socket.emitMessage({
                method: "Page.navigatedWithinDocument",
                params: { url: `http://tauri.localhost/${route}` },
              });
            }
            if (message.method === "Page.captureScreenshot") {
              return {
                id: message.id,
                result: { data: screenshotBytes.toString("base64") },
              };
            }
            return { id: message.id, result: {} };
          },
        );
        const result = await runScenarioForTest({
          endpoint,
          tunnelOptions: { remote: "test@win10.test" },
          expectedRuntimeAttestation: ATTESTATION,
          expectedInitialRoute: "#/sale",
          sequenceName: "single-product-sale",
          webSocketFactory: factory,
          remoteCommandRunner: fakeWindowsCommandRunner,
          continuousCapture: false,
          screenshotCheckpoints: true,
          adapter: acceptanceAdapter({
            async screenshotSink({ sha256 }) {
              return { ref: `evidence/${sha256}.png` };
            },
          }),
          steps: [
            {
              type: "customer-activation",
              name: "buy",
              selector: "#buy",
              routeBefore: "#/sale",
              routeAfter: "#/checkout",
            },
            {
              type: "observation",
              name: "checkout-visible",
              route: "#/checkout",
            },
          ],
        });

        const activation = result.evidence.find(
          (entry) => entry.type === "customer-activation",
        );
        assert.equal(activation.input.method, "Input.dispatchTouchEvent");
        assert.equal(result.webSocketUrl, undefined);
        assert.equal(
          JSON.stringify(result).includes(screenshotBytes.toString("base64")),
          false,
        );
        assert.ok(
          result.evidence
            .filter((entry) => entry.screenshot)
            .every(
              (entry) =>
                /^[a-f0-9]{64}$/.test(entry.screenshot.sha256) &&
                entry.screenshot.ref.startsWith("evidence/"),
            ),
        );
        assert.deepEqual(
          result.evidence.map((entry) => entry.capturedAt),
          [...result.evidence]
            .map((entry) => entry.capturedAt)
            .sort((left, right) => left.localeCompare(right)),
        );
        assert.ok(
          sockets[0].sent.some((message) =>
            message.method.startsWith("Input."),
          ),
        );
        assert.deepEqual(result.execution, {
          planned: { customerActivations: 1, observations: 1, externalOperations: 0 },
          executed: {
            customerActivations: 1,
            observations: 1,
            externalOperations: 0,
          },
        });
      },
    );
  });

  it("installs route listeners before actions and rejects forbidden routes", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        const { factory, sockets } = createFakeWebSocketFactory(
          (message, socket) => {
            if (message.method === "Runtime.evaluate") {
              if (message.params.expression.includes("querySelector")) {
                return cdpValue(
                  {
                    selector: "#buy",
                    actionable: true,
                    bounds: { x: 0, y: 0, width: 10, height: 10 },
                    center: { x: 5, y: 5 },
                  },
                  message.id,
                );
              }
              return cdpValue(identity("#/sale"), message.id);
            }
            if (
              message.method === "Input.dispatchTouchEvent" &&
              message.params.type === "touchStart"
            ) {
              socket.emitMessage({
                method: "Page.navigatedWithinDocument",
                params: {
                  url: "http://tauri.localhost/#/maintenance?mode=operator",
                },
              });
            }
            return { id: message.id, result: {} };
          },
        );
        await assert.rejects(
          runScenarioForTest({
            endpoint,
            tunnelOptions: { remote: "test@win10.test" },
            expectedRuntimeAttestation: ATTESTATION,
            expectedInitialRoute: "#/sale",
            sequenceName: "forbidden-route",
            webSocketFactory: factory,
            remoteCommandRunner: fakeWindowsCommandRunner,
            continuousCapture: false,
            adapter: acceptanceAdapter(),
            steps: [
              {
                type: "customer-activation",
                name: "buy",
                selector: "#buy",
                routeBefore: "#/sale",
                routeAfter: "#/checkout",
              },
            ],
          }),
          /route capture failed: forbidden customer route observed: #\/maintenance/,
        );
      },
    );
  });

  it("allows catalog before the checkout route barrier", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/catalog")],
      async (endpoint) => {
        let route = "#/catalog";
        const { factory } = createFakeWebSocketFactory((message) => {
          if (message.method === "Runtime.evaluate") {
            if (message.params.expression.includes("querySelector")) {
              return cdpValue(
                {
                  selector: "#buy",
                  actionable: true,
                  inViewport: true,
                  pointerEvents: "auto",
                  hitTarget: true,
                  bounds: { x: 0, y: 0, width: 10, height: 10 },
                  center: { x: 5, y: 5 },
                },
                message.id,
              );
            }
            return cdpValue(identity(route), message.id);
          }
          if (
            message.method === "Input.dispatchTouchEvent" &&
            message.params.type === "touchStart"
          ) {
            route = "#/checkout";
          }
          return { id: message.id, result: {} };
        });
        const result = await runScenarioForTest({
          endpoint,
          tunnelOptions: { remote: "test@win10.test" },
          expectedRuntimeAttestation: ATTESTATION,
          expectedInitialRoute: "#/catalog",
          sequenceName: "catalog-before-barrier",
          adapter: acceptanceAdapter(),
          remoteCommandRunner: fakeWindowsCommandRunner,
          webSocketFactory: factory,
          continuousCapture: false,
          steps: [
            {
              type: "customer-activation",
              name: "buy",
              selector: "#buy",
              routeBefore: "#/catalog",
              routeAfter: "#/checkout",
            },
          ],
        });
        assert.equal(result.status, "passed");
      },
    );
  });

  it("fails the scenario when continuous identity capture fails", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        let evaluations = 0;
        const { factory, sockets } = createFakeWebSocketFactory((message) => {
          if (message.method === "Runtime.evaluate") {
            evaluations += 1;
            if (evaluations >= 3) {
              return { id: message.id, error: { message: "capture broke" } };
            }
            return cdpValue(identity("#/sale"), message.id);
          }
          return { id: message.id, result: {} };
        });
        await assert.rejects(
          runScenarioForTest({
            endpoint,
            tunnelOptions: { remote: "test@win10.test" },
            expectedRuntimeAttestation: ATTESTATION,
            expectedInitialRoute: "#/sale",
            sequenceName: "capture-failure",
            webSocketFactory: factory,
            continuousCapture: true,
            continuousCaptureIntervalMs: 1,
            adapter: acceptanceAdapter(),
            remoteCommandRunner: fakeWindowsCommandRunner,
            steps: [
              {
                type: "customer-activation",
                name: "buy",
                selector: "#buy",
                routeBefore: "#/sale",
                routeAfter: "#/checkout",
              },
            ],
          }),
          /capture broke/,
        );
        assert.equal(sockets[0].closeCalls, 1);
        assert.equal(sockets[0].readyState, 3);
      },
    );
  });

  it("evaluates continuous checkpoints against the policy captured when they start", async () => {
    let captureRequestId;
    let captureStarted;
    const started = new Promise((resolve) => {
      captureStarted = resolve;
    });
    const { factory, sockets } = createFakeWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        captureRequestId = message.id;
        captureStarted();
        return null;
      }
      return { id: message.id, result: {} };
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/policy", {
      webSocketFactory: factory,
    });
    await client.connect();

    let policy = {
      epoch: 0,
      forbiddenRoutes: ["/maintenance"],
      allowedRoutes: null,
    };
    const capture = startContinuousIdentityCapture(client, {
      intervalMs: 1,
      routePolicy: () => policy,
    });
    await started;

    policy = {
      epoch: 1,
      forbiddenRoutes: ["/maintenance"],
      allowedRoutes: ["/payment", "/dispensing", "/result"],
    };
    sockets[0].emitMessage(cdpValue(identity("#/checkout"), captureRequestId));

    const checkpoints = await capture.stop();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].identity.route, "#/checkout");
    await client.close();
  });

  it("rejects continuous checkpoints begun after the payment barrier", async () => {
    const { factory } = createFakeWebSocketFactory((message) =>
      cdpValue(identity("#/products/test-item"), message.id),
    );
    const client = new CdpClient("ws://127.0.0.1/devtools/page/policy", {
      webSocketFactory: factory,
    });
    await client.connect();
    const capture = startContinuousIdentityCapture(client, {
      intervalMs: 1,
      routePolicy: () => ({
        epoch: 1,
        forbiddenRoutes: ["/maintenance"],
        allowedRoutes: ["/payment", "/dispensing", "/result"],
      }),
    });
    await sleep(10);
    await assert.rejects(
      capture.stop(),
      /payment barrier route observed: #\/products\/test-item/,
    );
    await client.close();
  });

  it("reserves default continuous evidence capacity for the 120s serial and 30s inventory budget", async () => {
    const { factory } = createFakeWebSocketFactory((message) =>
      cdpValue(identity("#/payment"), message.id),
    );
    const client = new CdpClient("ws://127.0.0.1/devtools/page/capacity", {
      webSocketFactory: factory,
    });
    await client.connect();
    const capture = startContinuousIdentityCapture(client);
    for (let index = 0; index < 300; index += 1) {
      await capture.captureNow();
    }
    const checkpoints = await capture.stop();
    assert.equal(checkpoints.length, 300);
    await client.close();
  });

  it("runs an immutable copy of closed scenario steps and reports execution counts", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        let route = "#/sale";
        let releaseInspection;
        let inspectionOptions;
        let sidecarOptions;
        const inspection = new Promise((resolve) => {
          releaseInspection = resolve;
        });
        const { factory } = createFakeWebSocketFactory((message) => {
          if (message.method === "Runtime.evaluate") {
            if (message.params.expression.includes("querySelector")) {
              return cdpValue(
                {
                  selector: "#buy",
                  actionable: true,
                  inViewport: true,
                  pointerEvents: "auto",
                  hitTarget: true,
                  bounds: { x: 0, y: 0, width: 10, height: 10 },
                  center: { x: 5, y: 5 },
                },
                message.id,
              );
            }
            return cdpValue(identity(route), message.id);
          }
          if (
            message.method === "Input.dispatchTouchEvent" &&
            message.params.type === "touchStart"
          ) {
            route = "#/checkout";
          }
          return { id: message.id, result: {} };
        });
        const steps = [
          {
            type: "customer-activation",
            name: "buy",
            selector: "#buy",
            routeBefore: "#/sale",
            routeAfter: "#/checkout",
          },
          {
            type: "observation",
            name: "checkout",
            route: "#/checkout",
          },
        ];
        const running = runVisibleMachineSaleScenarioForTest(
          {
            endpoint,
            tunnelOptions: {
              remote: "test@win10.test",
              sshKnownHostsPath: "/tmp/vem-known-hosts",
              sshHostKeyAlias: "vem-factory-run-180",
            },
            expectedRuntimeAttestation: ATTESTATION,
            expectedInitialRoute: "#/sale",
            sequenceName: "immutable-sequence",
            continuousCapture: false,
            steps,
          },
          {
            webSocketFactory: factory,
            remoteCommandRunner: async (options) => {
              inspectionOptions = options;
              return inspection;
            },
            async openSidecar(options) {
              sidecarOptions = options;
              return { endpoint, async close() {} };
            },
          },
        );
        steps[0].routeAfter = "#/maintenance";
        steps.push({ type: "observation", name: "injected", route: "#/sale" });
        releaseInspection(OBSERVED_RUNTIME);

        const result = await running;
        assert.deepEqual(result.execution, {
          planned: { customerActivations: 1, observations: 1, externalOperations: 0 },
          executed: {
            customerActivations: 1,
            observations: 1,
            externalOperations: 0,
          },
        });
        assert.deepEqual(sidecarOptions, {
          remote: "test@win10.test",
          sshKnownHostsPath: "/tmp/vem-known-hosts",
          sshHostKeyAlias: "vem-factory-run-180",
          remoteCdpHost: "127.0.0.1",
          remoteCdpPort: 9222,
        });
        assert.equal(
          inspectionOptions.sshKnownHostsPath,
          "/tmp/vem-known-hosts",
        );
        assert.equal(inspectionOptions.sshHostKeyAlias, "vem-factory-run-180");
      },
    );
  });

  it("fails closed when route or continuous evidence cardinality overflows", async () => {
    await withFakeHttpTargets(
      [target("machine-target", "#/sale")],
      async (endpoint) => {
        const { factory } = createFakeWebSocketFactory((message, socket) => {
          if (message.method === "Page.enable") {
            for (let index = 0; index <= 128; index += 1) {
              socket.emitMessage({
                method: "Page.navigatedWithinDocument",
                params: { url: "http://tauri.localhost/#/sale" },
              });
            }
          }
          if (message.method === "Runtime.evaluate") {
            return cdpValue(identity("#/sale"), message.id);
          }
          return { id: message.id, result: {} };
        });
        await assert.rejects(
          runScenarioForTest({
            endpoint,
            tunnelOptions: { remote: "test@win10.test" },
            expectedRuntimeAttestation: ATTESTATION,
            expectedInitialRoute: "#/sale",
            sequenceName: "route-overflow",
            continuousCapture: false,
            webSocketFactory: factory,
            steps: [
              {
                type: "customer-activation",
                name: "buy",
                selector: "#buy",
                routeBefore: "#/sale",
                routeAfter: "#/checkout",
              },
            ],
          }),
          /route evidence exceeded maximum entries/,
        );
      },
    );

    const { factory } = createFakeWebSocketFactory((message) =>
      cdpValue(identity("#/sale"), message.id),
    );
    const client = new CdpClient("ws://127.0.0.1/devtools/page/overflow", {
      webSocketFactory: factory,
    });
    await client.connect();
    const capture = startContinuousIdentityCapture(client, {
      intervalMs: 1,
      maxCheckpoints: 1,
    });
    await sleep(20);
    await assert.rejects(capture.stop(), /exceeded maximum evidence entries/);
    await client.close();
  });

  it("escalates a timed-out runtime inspection from TERM to KILL and awaits exit", async () => {
    const child = new FakeChildProcess();
    child.onKill = (signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => child.finish(1, "SIGKILL"));
      }
    };
    await assert.rejects(
      runWindowsPowerShellOverSshForTest(
        {
          remote: "user@example.test",
          timeoutMs: 1,
          script: "Write-Output '{}'",
        },
        {
          processAdapter: {
            spawn() {
              return child;
            },
          },
          shutdownTimeoutMs: 1,
        },
      ),
      /Windows runtime inspection timed out/,
    );
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.exitCode, 1);
  });

  it("returns screenshot digests and sink refs, never base64", async () => {
    const image = Buffer.from("bounded-image");
    const { factory } = createFakeWebSocketFactory((message) => ({
      id: message.id,
      result: { data: image.toString("base64") },
    }));
    const client = new CdpClient("ws://127.0.0.1/devtools/page/screenshot", {
      webSocketFactory: factory,
    });
    await client.connect();
    const evidence = await captureScreenshot(client, {
      screenshotSink: ({ sha256 }) => `sink://${sha256}`,
    });
    assert.equal(evidence.byteLength, image.length);
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
    assert.equal("data" in evidence, false);
    assert.equal(
      JSON.stringify(evidence).includes(image.toString("base64")),
      false,
    );
    await client.close();
  });
});

function target(id, route) {
  return {
    id,
    url: `http://tauri.localhost/${route}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

function identity(route) {
  return {
    url: `http://tauri.localhost/${route}`,
    route,
    pathname: "/",
    title: "Machine",
    readyState: "complete",
    activeElement: "body",
    domLength: 42,
    domHash: "deadbeef",
  };
}

function cdpValue(value, id) {
  return { id, result: { result: { value } } };
}

async function withFakeHttpTargets(targets, callback) {
  const server = createServer((request, response) => {
    if (request.url !== "/json") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(targets));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createFakeWebSocketFactory(handler, options = {}) {
  const sockets = [];
  return {
    sockets,
    factory(url) {
      const socket = new FakeWebSocket(url, handler, options);
      sockets.push(socket);
      return socket;
    },
  };
}

class FakeWebSocket {
  constructor(url, handler, options) {
    this.url = url;
    this.handler = handler;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit("open", {});
    });
  }

  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, once: options.once === true });
  }

  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }

  send(raw) {
    if (this.sendError) throw this.sendError;
    const message = JSON.parse(raw);
    this.sent.push(message);
    const response = this.handler(message, this);
    if (response == null) return;
    queueMicrotask(() => this.emitMessage(response));
  }

  emitMessage(message) {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 2;
    if (this.options.autoClose !== false) this.finishClose();
  }

  finishClose() {
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type, event) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) entry.handler(event);
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => !entry.once),
    );
  }
}

class FakeStream extends EventEmitter {
  resumed = false;

  resume() {
    this.resumed = true;
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killSignals = [];
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  finish(code, signal) {
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
