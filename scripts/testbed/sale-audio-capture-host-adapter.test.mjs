import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createSaleAudioCaptureRequest,
  createFileBackedAudioCaptureTestBackend,
  executeSaleAudioCaptureHostAdapter,
  runSaleAudioCaptureHostAdapterCli,
  SALE_AUDIO_REPORT_SCHEMA_VERSION,
  validateSaleAudioCaptureReport,
} from "./sale-audio-capture-host-adapter.mjs";

const runtime = {
  processId: 42,
  executablePath: "C:\\VEM\\bringup\\machine.exe",
  principal: "FIELD\\InteractivePrincipal",
  sessionId: 4,
  cdpTargetId: "target-42",
  cdpSessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
};

function report(request) {
  return {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: { identity: "vm-host-adapter://production", version: "1.0.0" },
    request,
    captureSession: {
      captureSessionId: "sale-audio-session://42",
      startOperationReference: request.operationReference,
      startedAt: "2026-07-18T08:00:00.000Z",
    },
    capture: null,
    evidence: [],
  };
}

function makeTempDir(prefix) {
  const path = join(
    process.cwd(),
    "test-artifacts",
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

function wavWithTone(frameCount = 48_000, sampleRate = 48_000, channels = 2) {
  const blockAlign = channels * 2;
  const data = Buffer.alloc(frameCount * blockAlign);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = frame % 8 < 2 ? 1_024 : frame % 8 < 4 ? 2_048 : 0;
    for (let channel = 0; channel < channels; channel += 1) {
      data.writeInt16LE(sample, frame * blockAlign + channel * 2);
    }
  }
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

function delayedPickupFrames() {
  return [
    ["daemon-to-controller", "55020531", 2, "VEND"],
    ["controller-to-daemon", "55F0", 240, "F0"],
    ["controller-to-daemon", "55F1", 241, "F1"],
    ["controller-to-daemon", "55F2", 242, "F2"],
  ].map(([direction, rawFrameHex, opcode, parsedOpcode], index) => ({
    direction,
    rawFrameHex,
    opcode,
    parsedOpcode,
    capturedAt: `2026-07-18T08:00:0${index}.000Z`,
  }));
}

function productionBinding(serialJournalPath) {
  return {
    libvirtUri: "qemu:///system",
    domainName: "win10-runtime-testbed",
    serialJournalPath,
  };
}

describe("capture-sale-audio host adapter extension", () => {
  it("starts before business IDs exist while binding the installed process and transaction", () => {
    const request = createSaleAudioCaptureRequest({
      phase: "start",
      runId: "RUN-17",
      lifecycleReference: "vm-lifecycle://run-17.runtime",
      targetIdentity: "vm-target://runtime",
      transactionId: "transaction://run-17",
      runtime,
      operationNonce: "op-11111111111111111111111111111111",
    });
    const validated = validateSaleAudioCaptureReport(report(request), request);
    assert.equal(validated.request.runtime.principal, runtime.principal);
    assert.equal(validated.request.sale, null);
    assert.equal(validated.request.operation, "capture-sale-audio");
    assert.throws(
      () =>
        validateSaleAudioCaptureReport(
          report({ ...request, endpointId: "forbidden-endpoint" }),
          { ...request, endpointId: "forbidden-endpoint" },
        ),
      /fields are invalid/,
    );
  });

  it("requires the stop request to carry order, command number, command ID, and transaction", () => {
    assert.throws(
      () =>
        createSaleAudioCaptureRequest({
          phase: "stop",
          runId: "RUN-17",
          lifecycleReference: "vm-lifecycle://run-17.runtime",
          targetIdentity: "vm-target://runtime",
          transactionId: "transaction://run-17",
          runtime,
          captureSessionId: "sale-audio-session://42",
          startOperationReference:
            "vm-operation://op-11111111111111111111111111111111",
          captureStartedAt: "2026-07-18T08:00:00.000Z",
          sale: {
            saleCorrelationId: "sale-correlation://run-17",
            orderId: "11111111-1111-4111-8111-111111111111",
            orderNo: "ORDER-17",
            commandId: "22222222-2222-4222-8222-222222222222",
          },
        }),
      /commandNo/,
    );
  });

  it("is callable through the repo-owned CLI without calibration or endpoint arguments", async () => {
    const root = makeTempDir("vem-sale-audio-host");
    let observedRequest;
    try {
      const result = await runSaleAudioCaptureHostAdapterCli(
        [
          "--operation",
          "capture-sale-audio",
          "--capture-phase",
          "start",
          "--run-id",
          "RUN-17",
          "--lifecycle-reference",
          "vm-lifecycle://run-17.runtime",
          "--target-identity",
          "vm-target://runtime",
          "--transaction-id",
          "transaction://run-17",
          "--machine-process-id",
          "42",
          "--machine-executable-path",
          runtime.executablePath,
          "--interactive-principal",
          runtime.principal,
          "--interactive-session-id",
          "4",
          "--cdp-target-id",
          runtime.cdpTargetId,
          "--cdp-session-id",
          runtime.cdpSessionId,
          "--evidence-dir",
          join(root, "evidence"),
          "--out",
          join(root, "report.json"),
          "--libvirt-uri",
          "qemu:///system",
          "--domain-name",
          "win10-runtime-testbed",
          "--serial-journal-path",
          join(root, "raw-serial.socat.log"),
        ],
        {
          async invokeAdapter(request) {
            observedRequest = request;
            return report(request);
          },
        },
      );
      assert.equal(result.result, "succeeded");
      assert.equal(observedRequest.operation, "capture-sale-audio");
      assert.equal(
        JSON.stringify(observedRequest).includes("audio_output_calibration"),
        false,
      );
      assert.equal(Object.hasOwn(observedRequest, "endpointId"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the file-backed WAV and JSON PTY fixture behind injected test dependencies", async () => {
    const root = makeTempDir("vem-sale-audio-file");
    const evidenceDirectory = join(root, "evidence");
    const journalPath = join(root, "raw-serial.jsonl");
    const wavPath = join(root, "captured.wav");
    try {
      writeFileSync(wavPath, "");
      const dependencies = {
        backendFactory: () => createFileBackedAudioCaptureTestBackend(wavPath),
        readSerialJournal: () => delayedPickupFrames(),
      };
      const started = await executeSaleAudioCaptureHostAdapter(
        {
          phase: "start",
          runId: "RUN-17-FILE",
          lifecycleReference: "vm-lifecycle://run-17-file.runtime",
          targetIdentity: "vm-target://runtime",
          transactionId: "transaction://run-17-file",
          runtime,
          evidenceDirectory,
          outPath: join(root, "start.json"),
          production: productionBinding(journalPath),
        },
        dependencies,
      );
      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55020531",
            opcode: 2,
            parsedOpcode: "VEND",
            capturedAt: "2026-07-18T08:00:00.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
            capturedAt: "2026-07-18T08:00:01.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
            capturedAt: "2026-07-18T08:00:02.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F2",
            opcode: 242,
            parsedOpcode: "F2",
            capturedAt: "2026-07-18T08:00:03.000Z",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      writeFileSync(wavPath, wavWithTone());
      const stopped = await executeSaleAudioCaptureHostAdapter(
        {
          phase: "stop",
          runId: "RUN-17-FILE",
          lifecycleReference: "vm-lifecycle://run-17-file.runtime",
          targetIdentity: "vm-target://runtime",
          transactionId: "transaction://run-17-file",
          runtime,
          captureSessionId: started.captureSession.captureSessionId,
          startOperationReference:
            started.captureSession.startOperationReference,
          captureStartedAt: started.captureSession.startedAt,
          sale: {
            saleCorrelationId: "sale-correlation://run-17-file",
            orderId: "11111111-1111-4111-8111-111111111111",
            orderNo: "ORDER-17-FILE",
            commandId: "22222222-2222-4222-8222-222222222222",
            commandNo: "COMMAND-17-FILE",
          },
          evidenceDirectory,
          outPath: join(root, "stop.json"),
          production: productionBinding(journalPath),
        },
        dependencies,
      );
      const serialEvidence = stopped.evidence.find(
        (entry) => entry.role === "sale-serial-frame-capture",
      );
      const serialCapture = JSON.parse(
        readFileSync(join(evidenceDirectory, serialEvidence.fileName), "utf8"),
      );
      assert.equal(serialCapture.frames[0].direction, "guest_to_host");
      assert.equal(serialCapture.frames[1].direction, "host_to_guest");
      assert.equal(stopped.capture.source, "windows_default_output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the running domain's sole audio output and snapshots its live inode without ambient injection", async () => {
    const root = makeTempDir("vem-sale-audio-libvirt");
    const evidenceDirectory = join(root, "evidence");
    const journalPath = join(root, "raw-serial.socat.log");
    const wavPath = join(root, "domain-output.wav");
    const ignoredWavPath = join(root, "attacker-selected.wav");
    const domainXml = `<domain type="kvm"><devices><audio id="1" type="file" path="${wavPath}"/><sound model="ich9"><audio id="1"/></sound></devices></domain>`;
    const testOnlyRunVirsh = (args) => {
      if (args.at(-2) === "domstate") return "running\n";
      if (args.at(-2) === "dumpxml") return domainXml;
      throw new Error(`unexpected test virsh invocation: ${args.join(" ")}`);
    };
    try {
      writeFileSync(wavPath, "live-wav");
      writeFileSync(journalPath, "not a JSON PTY fixture\n");
      const common = {
        runId: "RUN-17-LIBVIRT",
        lifecycleReference: "vm-lifecycle://run-17-libvirt.runtime",
        targetIdentity: "vm-target://runtime",
        transactionId: "transaction://run-17-libvirt",
        runtime,
        evidenceDirectory,
        production: productionBinding(journalPath),
      };
      const dependencies = {
        testOnlyRunVirsh,
        readSerialJournal: () => delayedPickupFrames(),
      };
      const started = await executeSaleAudioCaptureHostAdapter(
        { ...common, phase: "start", outPath: join(root, "start.json") },
        {
          ...dependencies,
          environment: {
            VEM_VM_HOST_AUDIO_CAPTURE_MODE: "file",
            VEM_VM_HOST_AUDIO_CAPTURE_WAV_PATH: ignoredWavPath,
            VEM_VM_HOST_AUDIO_SERIAL_JOURNAL: join(root, "fixture.jsonl"),
          },
        },
      );
      writeFileSync(wavPath, wavWithTone());
      const stopped = await executeSaleAudioCaptureHostAdapter(
        {
          ...common,
          phase: "stop",
          captureSessionId: started.captureSession.captureSessionId,
          startOperationReference:
            started.captureSession.startOperationReference,
          captureStartedAt: started.captureSession.startedAt,
          outPath: join(root, "stop.json"),
          sale: {
            saleCorrelationId: "sale-correlation://run-17-libvirt",
            orderId: "11111111-1111-4111-8111-111111111111",
            orderNo: "ORDER-17-LIBVIRT",
            commandId: "22222222-2222-4222-8222-222222222222",
            commandNo: "COMMAND-17-LIBVIRT",
          },
        },
        dependencies,
      );
      assert.equal(existsSync(ignoredWavPath), false);
      assert.equal(
        stopped.capture.provenance.domain.domainName,
        "win10-runtime-testbed",
      );
      assert.equal(stopped.capture.provenance.wav.path, wavPath);
      assert.equal(
        stopped.capture.provenance.wav.startOffset,
        "live-wav".length,
      );
      assert.ok(stopped.capture.provenance.wav.capturedByteLength > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
