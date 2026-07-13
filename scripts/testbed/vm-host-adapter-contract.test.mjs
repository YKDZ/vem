import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createVmHostAdapterRequest,
  runVmHostAdapter,
  validateVmHostAdapterReport,
  validateVmHostAdapterRequest,
  VmHostAdapterExecutionError,
} from "./vm-host-adapter-contract.mjs";

const HASH = "a".repeat(64);
const FAKE_ADAPTER = new URL("./fake-vm-host-adapter.mjs", import.meta.url)
  .pathname;
const CLIENT = new URL("./run-vm-host-adapter.mjs", import.meta.url).pathname;
const CONFORMANCE = new URL(
  "./vm-host-adapter-conformance.mjs",
  import.meta.url,
).pathname;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(assertion, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await sleep(20);
  }
  assert.fail(message);
}

function requestFor(operation = "restore-approved-base", overrides = {}) {
  const nonce = "op-0123456789abcdef";
  const capabilities = {
    "restore-approved-base": [
      "approved-base-restore",
      "disposable-overlay",
      "serial:lower-controller",
      "serial:scanner",
      "cancellation",
      "cleanup",
    ],
    "capture-approved-base": [
      "approved-base-capture",
      "disposable-overlay",
      "cancellation",
      "cleanup",
    ],
    "capture-display": ["display-capture", "cancellation", "cleanup"],
    "capture-default-audio": [
      "default-audio-capture",
      "cancellation",
      "cleanup",
    ],
    cleanup: ["cleanup", "cancellation"],
    cancel: ["cancellation", "cleanup"],
  }[operation];
  return {
    schemaVersion: "vem-vm-host-adapter-request/v1",
    kind: "vm-host-adapter-request",
    operation,
    runId: "RUN-12-CONTRACT",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: "vm-lifecycle://run-12-contract.runtime-testbed",
    cancelOperationReference:
      operation === "cancel" ? "vm-operation://op-fedcba9876543210" : null,
    target: { identity: "vm-target://runtime-testbed" },
    factoryMedia: null,
    assets: [
      {
        role: "approved-runtime-base",
        identity: `factory-cas://sha256/${HASH}`,
        digest: `sha256:${HASH}`,
      },
    ],
    requestedCapabilities: capabilities,
    ...overrides,
  };
}

function reportFor(request, overrides = {}) {
  const completed = [request.operation];
  const evidence =
    request.operation === "capture-display"
      ? [
          {
            role: "display-capture",
            identity: `factory-evidence://sha256/${"b".repeat(64)}`,
            digest: `sha256:${"b".repeat(64)}`,
            fileName: `${"b".repeat(64)}.png`,
          },
        ]
      : request.operation === "capture-default-audio"
        ? [
            {
              role: "default-audio-capture",
              identity: `factory-evidence://sha256/${"c".repeat(64)}`,
              digest: `sha256:${"c".repeat(64)}`,
            },
          ]
        : [];
  return {
    schemaVersion: "vem-vm-host-adapter-report/v1",
    kind: "vm-host-adapter-report",
    adapter: {
      identity: "vm-host-adapter://deterministic-fake@1.0.0",
      version: "1.0.0",
    },
    request: {
      runId: request.runId,
      operation: request.operation,
      operationNonce: request.operationNonce,
      operationReference: request.operationReference,
      lifecycleReference: request.lifecycleReference,
      cancelOperationReference: request.cancelOperationReference,
      targetIdentity: request.target.identity,
      factoryMedia: request.factoryMedia,
      requestedCapabilities: request.requestedCapabilities,
    },
    result: "succeeded",
    negotiatedCapabilities: request.requestedCapabilities,
    completedOperations: completed,
    observed: {
      vmIdentity: "vm-observed://runtime-testbed-001",
      targetBinding: {
        relation: "host-target-mapping/v1",
        targetIdentity: request.target.identity,
      },
      baseIdentity: request.assets[0].identity,
      overlayIdentity: "vm-overlay://run-12-contract",
      factoryProvenanceDigest:
        request.operation === "clean-install" ||
        request.operation === "capture-approved-base"
          ? request.factoryMedia.provenanceDigest
          : null,
    },
    consumedAssets: request.assets,
    guest: {
      maintenanceEndpointIdentity: "guest-maintenance://runtime-testbed-001",
      maintenanceEndpoint: {
        protocol: "ssh",
        host: "10.91.2.10",
        port: 22,
        reachability: "discovered",
      },
      deviceMappings: request.requestedCapabilities.includes(
        "serial:lower-controller",
      )
        ? [
            {
              role: "lower-controller",
              guestDeviceIdentity: "guest-device://lower-controller-001",
            },
            {
              role: "scanner",
              guestDeviceIdentity: "guest-device://scanner-001",
            },
          ]
        : [],
      defaultAudioIdentity: "guest-audio://runtime-testbed-001",
    },
    evidence,
    timestamps: {
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: "2026-07-11T00:00:01.000Z",
    },
    cleanup:
      request.operation === "cleanup" || request.operation === "cancel"
        ? {
            status: "completed",
            overlayDisposition: "removed",
            observed: {
              overlay: "removed",
              runDirectory: "removed",
              personalizationMedia: "removed",
            },
          }
        : {
            status: "not-run",
            overlayDisposition: "active",
            observed: {
              overlay: "present",
              runDirectory: "present",
              personalizationMedia: "not-mounted",
            },
          },
    diagnostics: [{ code: "adapter_completed" }],
    ...overrides,
  };
}

describe("VM Host Adapter contract", () => {
  it("permits lifecycle cleanup to recover a failed clean install from its Factory ISO", () => {
    const request = createVmHostAdapterRequest(
      requestFor("cleanup", {
        assets: [
          {
            role: "factory-iso",
            identity: `factory-cas://sha256/${HASH}`,
            digest: `sha256:${HASH}`,
          },
        ],
      }),
    );
    assert.equal(request.assets[0].role, "factory-iso");
    assert.equal(
      validateVmHostAdapterReport(reportFor(request), request).observed
        .baseIdentity,
      request.assets[0].identity,
    );
  });

  it("accepts a strict logical restore request with operation and lifecycle references", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.deepEqual(validateVmHostAdapterRequest(request), request);
    assert.doesNotMatch(
      JSON.stringify(request),
      /\/mnt\/|unraid:|qcow2|C:\\\\/i,
    );
  });

  it("requires Factory Personalization Media for a logical clean install", () => {
    const request = requestFor("clean-install", {
      requestedCapabilities: ["clean-install", "cancellation", "cleanup"],
    });
    assert.throws(
      () => createVmHostAdapterRequest(request),
      /factory-personalization-media/,
    );
  });

  it("binds a clean-install observation to its requested Factory ISO, never an approved base fallback", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const personalization = `factory-cas://sha256/${"e".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("clean-install", {
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
          {
            role: "factory-personalization-media",
            identity: personalization,
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          manifestIdentity: `sha256:${"f".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"c".repeat(64)}`,
          provenanceDigest: `sha256:${"c".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        requestedCapabilities: [
          "clean-install",
          "disposable-overlay",
          "serial:lower-controller",
          "serial:scanner",
          "cancellation",
          "cleanup",
        ],
      }),
    );
    assert.equal(
      validateVmHostAdapterReport(reportFor(request), request).observed
        .baseIdentity,
      factoryIso,
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...reportFor(request).observed,
            baseIdentity: `factory-cas://sha256/${HASH}`,
          },
        }),
        request,
      ),
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...reportFor(request).observed,
            factoryProvenanceDigest: `sha256:${"0".repeat(64)}`,
          },
        }),
        request,
      ),
    );
  });

  it("captures a distinct approved base from the clean Factory ISO lifecycle", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = requestFor("capture-approved-base", {
      factoryMedia: {
        assemblyMode: "windows-serviced-iso",
        manifestIdentity: `sha256:${"e".repeat(64)}`,
        provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
        provenanceDigest: `sha256:${"f".repeat(64)}`,
        outputIdentity: factoryIso,
        outputDigest: `sha256:${"d".repeat(64)}`,
      },
      assets: [
        {
          role: "factory-iso",
          identity: factoryIso,
          digest: `sha256:${"d".repeat(64)}`,
        },
      ],
    });
    const report = reportFor(request);
    report.observed.baseIdentity = `factory-cas://sha256/${"1".repeat(64)}`;
    assert.equal(
      validateVmHostAdapterReport(report, request).observed.baseIdentity,
      `factory-cas://sha256/${"1".repeat(64)}`,
    );
  });

  it("accepts an idempotent approved-base capture with cleanup-completed unavailable endpoint", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("capture-approved-base", {
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          manifestIdentity: `sha256:${"e".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
          provenanceDigest: `sha256:${"f".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
        ],
      }),
    );
    const report = reportFor(request, {
      guest: {
        maintenanceEndpointIdentity:
          "guest-maintenance://unreachable-runtime-testbed-001",
        maintenanceEndpoint: {
          protocol: "ssh",
          host: "guest-unreachable.invalid",
          port: 22,
          reachability: "unavailable",
        },
        deviceMappings: [],
        defaultAudioIdentity: "guest-audio://runtime-testbed-001",
      },
      cleanup: {
        status: "completed",
        overlayDisposition: "removed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      },
    });

    assert.deepEqual(
      validateVmHostAdapterReport(report, request).cleanup,
      report.cleanup,
    );
  });

  it("rejects unavailable approved-base capture endpoints unless cleanup proves removal", () => {
    const factoryIso = `factory-cas://sha256/${"d".repeat(64)}`;
    const request = createVmHostAdapterRequest(
      requestFor("capture-approved-base", {
        factoryMedia: {
          assemblyMode: "windows-serviced-iso",
          manifestIdentity: `sha256:${"e".repeat(64)}`,
          provenanceIdentity: `factory-evidence://sha256/${"f".repeat(64)}`,
          provenanceDigest: `sha256:${"f".repeat(64)}`,
          outputIdentity: factoryIso,
          outputDigest: `sha256:${"d".repeat(64)}`,
        },
        assets: [
          {
            role: "factory-iso",
            identity: factoryIso,
            digest: `sha256:${"d".repeat(64)}`,
          },
        ],
      }),
    );
    const unavailableGuest = {
      maintenanceEndpointIdentity:
        "guest-maintenance://unreachable-runtime-testbed-001",
      maintenanceEndpoint: {
        protocol: "ssh",
        host: "guest-unreachable.invalid",
        port: 22,
        reachability: "unavailable",
      },
      deviceMappings: [],
      defaultAudioIdentity: "guest-audio://runtime-testbed-001",
    };

    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, { guest: unavailableGuest }),
        request,
      ),
    );

    for (const [key, value] of [
      ["overlay", "present"],
      ["runDirectory", "present"],
      ["personalizationMedia", "not-mounted"],
    ]) {
      assert.throws(() =>
        validateVmHostAdapterReport(
          reportFor(request, {
            guest: unavailableGuest,
            cleanup: {
              status: "completed",
              overlayDisposition: "removed",
              observed: {
                overlay: "removed",
                runDirectory: "removed",
                personalizationMedia: "removed",
                [key]: value,
              },
            },
          }),
          request,
        ),
      );
    }
  });

  it("requires a distinct canonical operation reference when cancelling", () => {
    const valid = createVmHostAdapterRequest(requestFor("cancel"));
    assert.equal(
      valid.cancelOperationReference,
      "vm-operation://op-fedcba9876543210",
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          requestFor("cancel", {
            cancelOperationReference: valid.operationReference,
          }),
        ),
      /distinct operation/,
    );
    assert.throws(
      () =>
        createVmHostAdapterRequest(
          requestFor("restore-approved-base", {
            cancelOperationReference: valid.operationReference,
          }),
        ),
      /must be null outside cancel/,
    );
  });

  it("binds the observed VM to the exact requested logical target and reconstructs only allowed output", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = reportFor(request);
    const validated = validateVmHostAdapterReport(report, request);
    assert.deepEqual(validated, report);
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: {
            ...report.observed,
            targetBinding: {
              relation: "host-target-mapping/v1",
              targetIdentity: "vm-target://other",
            },
          },
        }),
        request,
      ),
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          observed: { ...report.observed, hostPath: "/mnt/user/secret" },
        }),
        request,
      ),
    );
  });

  it("accepts a host-discovered endpoint and rejects an unavailable one", () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = reportFor(request);
    assert.equal(
      validateVmHostAdapterReport(report, request).guest.maintenanceEndpoint
        .host,
      "10.91.2.10",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(request, {
          guest: {
            ...report.guest,
            maintenanceEndpoint: {
              protocol: "ssh",
              host: "10.91.2.10",
              port: 22,
              reachability: "unavailable",
            },
          },
        }),
        request,
      ),
    );
  });

  it("allows cleanup to attest removal after its guest endpoint is gone", () => {
    const request = createVmHostAdapterRequest(requestFor("cleanup"));
    const report = reportFor(request, {
      guest: {
        maintenanceEndpointIdentity:
          "guest-maintenance://unreachable-runtime-testbed-001",
        maintenanceEndpoint: {
          protocol: "ssh",
          host: "guest-unreachable.invalid",
          port: 22,
          reachability: "unavailable",
        },
        deviceMappings: [],
        defaultAudioIdentity: "guest-audio://runtime-testbed-001",
      },
      cleanup: {
        status: "completed",
        overlayDisposition: "removed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      },
    });
    assert.equal(
      validateVmHostAdapterReport(report, request).result,
      "succeeded",
    );
  });

  it("keeps overlay lifecycle active through restore and separates the completed operation from negotiated capabilities", () => {
    const restore = createVmHostAdapterRequest(requestFor());
    const report = reportFor(restore, {
      negotiatedCapabilities: restore.requestedCapabilities,
      completedOperations: ["restore-approved-base"],
    });
    assert.equal(
      validateVmHostAdapterReport(report, restore).cleanup.overlayDisposition,
      "active",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(restore, {
          cleanup: {
            status: "completed",
            overlayDisposition: "removed",
            observed: {
              overlay: "removed",
              runDirectory: "removed",
              personalizationMedia: "removed",
            },
          },
        }),
        restore,
      ),
    );
    const capture = createVmHostAdapterRequest(requestFor("capture-display"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(capture), capture).evidence[0].role,
      "display-capture",
    );
    assert.throws(() =>
      validateVmHostAdapterReport(
        reportFor(restore, { evidence: reportFor(capture).evidence }),
        restore,
      ),
    );
    const cleanup = createVmHostAdapterRequest(requestFor("cleanup"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(cleanup), cleanup).cleanup
        .overlayDisposition,
      "removed",
    );
  });

  it("requires a digest-bound relative image file name for a display capture", () => {
    const capture = createVmHostAdapterRequest(requestFor("capture-display"));
    assert.equal(
      validateVmHostAdapterReport(reportFor(capture), capture).evidence[0]
        .fileName,
      `${"b".repeat(64)}.png`,
    );
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(capture, {
            evidence: [
              {
                ...reportFor(capture).evidence[0],
                fileName: "/runner/evidence/display.png",
              },
            ],
          }),
          capture,
        ),
      /fileName/,
    );
  });

  it("requires the runner to supply an absolute display evidence export directory", async () => {
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor("capture-display")),
          workDirectory: mkdtempSync(join(tmpdir(), "vem-vm-host-display-")),
          environment: { VEM_VM_HOST_ADAPTER: FAKE_ADAPTER },
        }),
      /VEM_VM_HOST_EVIDENCE_EXPORT_DIR must be an absolute runner-owned directory/,
    );
  });

  it("accepts a successful operation only when every requested capability is negotiated", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            negotiatedCapabilities: [
              "approved-base-restore",
              "disposable-overlay",
              "cancellation",
              "cleanup",
            ],
          }),
          request,
        ),
      /complete requested capability set/,
    );
  });

  it("requires every requested role-addressed device mapping before accepting a successful operation", () => {
    const request = createVmHostAdapterRequest(requestFor());
    assert.throws(
      () =>
        validateVmHostAdapterReport(
          reportFor(request, {
            negotiatedCapabilities: [
              "approved-base-restore",
              "disposable-overlay",
              "serial:lower-controller",
              "cancellation",
              "cleanup",
            ],
            guest: {
              ...reportFor(request).guest,
              deviceMappings: [
                {
                  role: "lower-controller",
                  guestDeviceIdentity: "guest-device://lower-controller-001",
                },
              ],
            },
          }),
          request,
        ),
      /must include scanner/,
    );
  });

  it("rejects duplicate serial and evidence roles, extra consumed asset fields, loose timestamps, and non-canonical evidence identity", () => {
    const request = createVmHostAdapterRequest(requestFor("capture-display"));
    const report = reportFor(request);
    const cases = [
      { ...report, secret: "leak" },
      reportFor(request, {
        consumedAssets: [{ ...request.assets[0], secret: "leak" }],
      }),
      reportFor(request, {
        guest: {
          ...report.guest,
          deviceMappings: [
            {
              role: "lower-controller",
              guestDeviceIdentity: "guest-device://one",
            },
            {
              role: "lower-controller",
              guestDeviceIdentity: "guest-device://two",
            },
          ],
        },
      }),
      reportFor(request, {
        evidence: [report.evidence[0], { ...report.evidence[0] }],
      }),
      reportFor(request, {
        evidence: [{ ...report.evidence[0], secret: "leak" }],
      }),
      reportFor(request, {
        evidence: [{ ...report.evidence[0], identity: "vm-evidence://frame" }],
      }),
      reportFor(request, {
        timestamps: {
          startedAt: "2026-07-11T00:00:00Z",
          completedAt: "2026-07-11T00:00:01Z",
        },
      }),
    ];
    for (const candidate of cases)
      assert.throws(() => validateVmHostAdapterReport(candidate, request));
    assert.throws(() =>
      createVmHostAdapterRequest({ ...request, hostPath: "/mnt/user/base" }),
    );
  });

  it("runs only the runner-service adapter and accepts a deterministic restore with an active overlay", async () => {
    const request = createVmHostAdapterRequest(requestFor());
    const report = await runVmHostAdapter({
      request,
      workDirectory: mkdtempSync(join(tmpdir(), "vem-vm-host-client-")),
      environment: {
        VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
        VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
      },
    });
    assert.equal(report.result, "succeeded");
    assert.equal(report.cleanup.overlayDisposition, "active");
  });

  it("terminates a genuinely hanging child with SIGTERM, invokes cleanup, and persists a sanitized timeout diagnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-timeout-"));
    const signalFile = join(root, "adapter.signal");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          timeoutMs: 80,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
        }),
      (error) => {
        assert.ok(error instanceof VmHostAdapterExecutionError);
        assert.equal(error.diagnostic.result, "timed_out");
        assert.deepEqual(error.diagnostic.cleanup, {
          attempted: true,
          status: "completed",
          observed: {
            overlay: "removed",
            runDirectory: "removed",
            personalizationMedia: "removed",
          },
        });
        assert.doesNotMatch(
          JSON.stringify(error.diagnostic),
          /\/mnt\/|secret|password|private.?key/i,
        );
        return true;
      },
    );
    assert.equal(existsSync(signalFile), true);
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM\n");
  });

  it("cancels a hanging child through AbortSignal with the same cleanup and signal semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cancel-"));
    const signalFile = join(root, "adapter.signal");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          timeoutMs: 1000,
          signal: controller.signal,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.result === "cancelled" &&
        error.diagnostic.cleanup.status === "completed",
    );
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM\n");
  });

  it("writes a sanitized failed diagnostic for workflow upload", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cli-"));
    const out = join(root, "report.json");
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          CLIENT,
          "--operation",
          "restore-approved-base",
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--out",
          out,
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
          },
        },
      ),
    );
    const diagnostic = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(diagnostic.result, "failed");
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /\/mnt\/|password|private.?key/i,
    );
  });

  it("runs validated recovery cleanup after an ordinary adapter failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-failure-"));
    const cleanupFile = join(root, "cleanup.txt");
    await assert.rejects(
      () =>
        runVmHostAdapter({
          request: createVmHostAdapterRequest(requestFor()),
          workDirectory: root,
          environment: {
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "failure",
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
          },
        }),
      (error) =>
        error instanceof VmHostAdapterExecutionError &&
        error.diagnostic.cleanup.status === "completed" &&
        error.diagnostic.cleanup.observed.overlay === "removed",
    );
    assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
  });

  it("builds a logical clean-install request from Factory ISO and personalization asset identities", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-clean-install-"));
    const out = join(root, "report.json");
    execFileSync(
      process.execPath,
      [
        CLIENT,
        "--operation",
        "clean-install",
        "--run-id",
        "RUN-12-CONTRACT",
        "--target-identity",
        "vm-target://runtime-testbed",
        "--factory-iso",
        `factory-cas://sha256/${"d".repeat(64)}`,
        "--factory-personalization-media",
        `factory-cas://sha256/${"e".repeat(64)}`,
        "--factory-assembly-mode",
        "windows-serviced-iso",
        "--factory-manifest",
        `sha256:${"f".repeat(64)}`,
        "--factory-provenance",
        `factory-evidence://sha256/${"c".repeat(64)}`,
        "--factory-provenance-digest",
        `sha256:${"c".repeat(64)}`,
        "--out",
        out,
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
        },
      },
    );
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(
      report.consumedAssets.map((asset) => asset.role),
      ["factory-iso", "factory-personalization-media"],
    );
  });

  it("does not let an adapter claim conformance while clean install is blocked by Issue15", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-conformance-"));
    const out = join(root, "conformance.json");
    assert.throws(() =>
      execFileSync(process.execPath, [CONFORMANCE, "--out", out], {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
          VEM_VM_HOST_TARGET_ID: "vm-target://runtime-testbed",
          VEM_VM_HOST_APPROVED_BASE_ID: `factory-cas://sha256/${HASH}`,
          VEM_VM_HOST_FACTORY_ISO_ID: `factory-cas://sha256/${"d".repeat(64)}`,
          VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID: `factory-cas://sha256/${"e".repeat(64)}`,
          VEM_VM_HOST_EVIDENCE_EXPORT_DIR: join(root, "evidence-export"),
          VEM_VM_HOST_CLEAN_INSTALL_STATUS: "blocked-issue15",
          VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "success",
        },
      }),
    );
    const evidence = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(evidence.evidence.cleanInstall, {
      status: "blocked-issue15",
    });
  });

  it("cancels the CLI subprocess, waits for its hanging adapter, persists a diagnostic, and coordinates recovery cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-cli-cancel-"));
    const out = join(root, "diagnostic.json");
    const pidFile = join(root, "adapter.pid");
    const cleanupFile = join(root, "cleanup.txt");
    const cancelFile = join(root, "cancel.txt");
    const signalFile = join(root, "signal.txt");
    let client;
    let adapterPid;
    try {
      client = spawn(
        process.execPath,
        [
          CLIENT,
          "--operation",
          "restore-approved-base",
          "--run-id",
          "RUN-12-CONTRACT",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${HASH}`,
          "--out",
          out,
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER: FAKE_ADAPTER,
            VEM_VM_HOST_ADAPTER_FAKE_SCENARIO: "hang",
            VEM_VM_HOST_ADAPTER_PID_FILE: pidFile,
            VEM_VM_HOST_ADAPTER_CLEANUP_FILE: cleanupFile,
            VEM_VM_HOST_ADAPTER_CANCEL_FILE: cancelFile,
            VEM_VM_HOST_ADAPTER_SIGNAL_FILE: signalFile,
          },
          stdio: "ignore",
        },
      );
      await waitFor(() => existsSync(pidFile), "adapter did not start");
      adapterPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(adapterPid));

      client.kill("SIGTERM");
      const [exitCode] = await once(client, "close");
      assert.notEqual(exitCode, 0);
      await waitFor(() => {
        try {
          process.kill(adapterPid, 0);
          return false;
        } catch (error) {
          return error?.code === "ESRCH";
        }
      }, "adapter process remained after CLI cancellation");

      const diagnostic = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(diagnostic.result, "cancelled");
      assert.deepEqual(diagnostic.cleanup, {
        attempted: true,
        status: "completed",
        observed: {
          overlay: "removed",
          runDirectory: "removed",
          personalizationMedia: "removed",
        },
      });
      assert.equal(readFileSync(cleanupFile, "utf8"), "cleanup\n");
      assert.equal(
        readFileSync(cancelFile, "utf8").trim(),
        diagnostic.request.operationReference,
      );
      assert.equal(
        readFileSync(signalFile, "utf8").trim(),
        "SIGTERM",
        "the operation-reference-bound cancel request must signal the in-flight adapter",
      );
    } finally {
      client?.kill("SIGKILL");
      if (Number.isInteger(adapterPid)) {
        try {
          process.kill(adapterPid, "SIGKILL");
        } catch {}
      }
    }
  });
});
