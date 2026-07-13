import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  assessVisionReleaseCandidate,
  createVisionReleaseApproval,
  createVisionReleaseDescriptor,
  runVisionReleaseConformance,
  sanitizeVisionReleaseEvidence,
  verifySignedVisionReleaseEvidence,
  verifyVisionReleaseSelection,
} from "./vision-release.mjs";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const digest = (hash = HASH) => `sha256:${hash}`;
const evidence = (hash = HASH) => `factory-evidence://sha256/${hash}`;
const digestJsonForFixture = (value) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex")}`;

function releaseFixture() {
  const descriptor = createVisionReleaseDescriptor({
    releaseVersion: "1.2.3",
    bundle: {
      digest: digest(),
      bytes: 42,
      platform: { os: "windows", architecture: "x86_64" },
      format: "zip",
      extractor: {
        contractVersion: "vem-vision-extractor/v1",
        handler: "zip-safe-v1",
      },
    },
    entrypoint: { command: "vision-runtime.exe", arguments: [] },
    lifecycle: { requiresInteractiveSession: true, shutdownTimeoutMs: 5000 },
    configuration: {
      format: "json",
      schemaVersion: "vendor-vision-config/v1",
      argument: "--config",
    },
    health: {
      port: 7892,
      path: "/health",
      expectedStatus: 200,
      timeoutMs: 5000,
    },
    protocol: { version: "vem.vision.v1", webSocketPath: "/ws" },
    sbom: { identity: evidence(), digest: digest(), format: "spdx-json" },
    provenance: {
      identity: evidence(),
      digest: digest(),
      predicateType: "https://slsa.dev/provenance/v1",
    },
  });
  const attestation = {
    schemaVersion: "vem-vision-artifact-attestation/v1",
    kind: "vision-artifact-attestation",
    bundleDigest: descriptor.bundle.digest,
    descriptorDigest: descriptor.identity,
    sbomDigest: descriptor.sbom.digest,
    provenanceDigest: descriptor.provenance.digest,
    signerIdentity: `spki-sha256:${HASH}`,
  };
  const approval = createVisionReleaseApproval({
    releaseVersion: descriptor.releaseVersion,
    bundleDigest: descriptor.bundle.digest,
    descriptorDigest: descriptor.identity,
    attestationDigest: digestJsonForFixture(attestation),
    conformanceEvidenceDigest: digest(),
    approverIdentity: "vem-release-approval:production",
  });
  const manifestAsset = {
    role: "vision-release",
    digest: descriptor.bundle.digest,
    version: descriptor.releaseVersion,
    release: {
      descriptorIdentity: `factory-evidence://sha256/${descriptor.identity.slice(7)}`,
      descriptorDigest: descriptor.identity,
      attestationIdentity: evidence(digestJsonForFixture(attestation).slice(7)),
      attestationDigest: digestJsonForFixture(attestation),
      approvalIdentity: `factory-evidence://sha256/${approval.identity.slice(7)}`,
      approvalDigest: approval.identity,
      conformanceEvidenceIdentity: evidence(),
      conformanceEvidenceDigest: digest(),
    },
  };
  return { descriptor, attestation, approval, manifestAsset };
}

describe("Vision Release Bundle contract", () => {
  it("accepts one immutable approved release selection", () => {
    const fixture = releaseFixture();
    const selected = verifyVisionReleaseSelection(fixture);

    assert.equal(selected.releaseVersion, "1.2.3");
    assert.equal(selected.bundleDigest, digest());
  });

  it("rejects digest, attestation, descriptor, or approval disagreement before selection", () => {
    for (const mutate of [
      (fixture) => (fixture.manifestAsset.digest = digest(OTHER_HASH)),
      (fixture) => (fixture.attestation.bundleDigest = digest(OTHER_HASH)),
      (fixture) => (fixture.approval.bundleDigest = digest(OTHER_HASH)),
      (fixture) =>
        (fixture.manifestAsset.release.approvalDigest = digest(OTHER_HASH)),
    ]) {
      const fixture = releaseFixture();
      mutate(fixture);
      assert.throws(
        () => verifyVisionReleaseSelection(fixture),
        /match|digest/i,
      );
    }
  });

  it("assesses the supplied archive but keeps it unapproved without release metadata and evidence", () => {
    const result = assessVisionReleaseCandidate({
      bundleDigest:
        "sha256:9dc9dda0fb60a69cfac142bbbfd09f769b8ef965c0f4d3bbc8ccf3a8e33d4b1b",
      bundleBytes: 282822940,
    });

    assert.equal(result.approved, false);
    assert.deepEqual(result.missing, [
      "descriptor",
      "attestation",
      "sbom",
      "provenance",
      "conformanceEvidence",
      "approval",
    ]);
  });

  it("redacts config values, host paths, credentials, and private runtime paths from failure evidence", () => {
    const evidencePayload = sanitizeVisionReleaseEvidence({
      bundleDigest: digest(),
      installedDigest: digest(),
      configPath: "C:\\ProgramData\\VEM\\vision\\config.json",
      config: { apiKey: "secret-value" },
      privateRuntimePath: "C:\\VEM\\vision\\releases\\1.2.3-a\\model.bin",
      error: "connection failed for token=secret-value",
    });

    assert.deepEqual(evidencePayload, {
      bundleDigest: digest(),
      installedDigest: digest(),
      failure: "connection failed",
      redacted: true,
    });
    assert.equal(
      JSON.stringify(evidencePayload).includes("secret-value"),
      false,
    );
  });

  it("redacts drive, UNC, and POSIX paths embedded in arbitrary errors", () => {
    const failure = sanitizeVisionReleaseEvidence({
      error:
        "failed C:\\VEM\\vision\\runtime.exe; \\\\factory-host\\vision-share\\model.bin; /opt/vendor/vision/model.bin; token=do-not-leak",
    }).failure;

    assert.equal(typeof failure, "string");
    assert.doesNotMatch(
      failure,
      /C:\\VEM|factory-host|vision-share|\/opt\/vendor|do-not-leak/i,
    );
  });

  it("runs HTTP and WebSocket black-box conformance against the exact selected digest", async () => {
    const fixture = releaseFixture();
    const evidencePayload = await runVisionReleaseConformance({
      selection: {
        bundleDigest: fixture.descriptor.bundle.digest,
        descriptorDigest: fixture.descriptor.identity,
      },
      descriptor: fixture.descriptor,
      httpProbe: async ({ port, path }) => {
        assert.equal(port, 7892);
        assert.equal(path, "/health");
        return { status: 200 };
      },
      webSocketProbe: async ({ path, protocolVersion }) => {
        assert.equal(path, "/ws");
        assert.equal(protocolVersion, "vem.vision.v1");
        return {
          open: true,
          ready: {
            protocol: "vem.vision.v1",
            type: "vision.ready",
            messageId: "ready-1",
            timestamp: "2026-07-11T00:00:00.000Z",
            payload: {
              serverName: "fixture",
              serverVersion: "1.0.0",
              cameraReady: true,
              modelReady: true,
              capabilities: [],
            },
          },
        };
      },
    });

    assert.deepEqual(evidencePayload, {
      bundleDigest: digest(),
      installedDigest: digest(),
      descriptorDigest: fixture.descriptor.identity,
      redacted: true,
    });
  });

  it("rejects failed health or WebSocket probes rather than approving a different digest", async () => {
    const fixture = releaseFixture();
    await assert.rejects(
      runVisionReleaseConformance({
        selection: {
          bundleDigest: digest(OTHER_HASH),
          descriptorDigest: fixture.descriptor.identity,
        },
        descriptor: fixture.descriptor,
        httpProbe: async () => ({ status: 200 }),
        webSocketProbe: async () => ({ open: true }),
      }),
      /exact release digest/,
    );
    await assert.rejects(
      runVisionReleaseConformance({
        selection: {
          bundleDigest: digest(),
          descriptorDigest: fixture.descriptor.identity,
        },
        descriptor: fixture.descriptor,
        httpProbe: async () => ({ status: 200 }),
        webSocketProbe: async () => ({ open: false }),
      }),
      /WebSocket conformance failed/,
    );
  });

  it("requires the exact vem.vision.v1 hello and ready envelopes during black-box conformance", async () => {
    const fixture = releaseFixture();
    await runVisionReleaseConformance({
      selection: {
        bundleDigest: fixture.descriptor.bundle.digest,
        descriptorDigest: fixture.descriptor.identity,
      },
      descriptor: fixture.descriptor,
      httpProbe: async () => ({ status: 200 }),
      webSocketProbe: async ({ hello }) => {
        assert.equal(hello.protocol, "vem.vision.v1");
        assert.equal(hello.type, "vision.hello");
        assert.equal(hello.payload.clientRole, "machine");
        return {
          open: true,
          ready: {
            protocol: "vem.vision.v1",
            type: "vision.ready",
            messageId: "ready-test",
            timestamp: "2026-07-11T00:00:00.000Z",
            payload: {
              serverName: "fixture",
              serverVersion: "1.0.0",
              cameraReady: true,
              modelReady: true,
              capabilities: ["profile_push"],
            },
          },
        };
      },
    });
  });

  it("does not treat an empty signed-evidence delivery unit as approved", () => {
    const fixture = releaseFixture();
    assert.throws(
      () =>
        verifySignedVisionReleaseEvidence({
          manifestAsset: fixture.manifestAsset,
          documents: {},
          signatures: {},
          approvedIdentities: {},
        }),
      /bytes are invalid/i,
    );
  });

  it("keeps an inventory entry unapproved when every evidence field is empty", () => {
    const result = assessVisionReleaseCandidate({
      bundleDigest: digest(),
      bundleBytes: 1,
      descriptor: {},
      attestation: {},
      sbom: Buffer.alloc(0),
      provenance: "",
      conformanceEvidence: {},
      approval: {},
    });
    assert.equal(result.approved, false);
    assert.deepEqual(result.missing, [
      "descriptor",
      "attestation",
      "sbom",
      "provenance",
      "conformanceEvidence",
      "approval",
    ]);
  });

  it("does not promote structurally complete candidate metadata without signed verification", () => {
    const fixture = releaseFixture();
    const result = assessVisionReleaseCandidate({
      bundleDigest: fixture.descriptor.bundle.digest,
      bundleBytes: fixture.descriptor.bundle.bytes,
      descriptor: Buffer.from(JSON.stringify(fixture.descriptor)),
      attestation: Buffer.from(JSON.stringify(fixture.attestation)),
      sbom: Buffer.from('{"spdxVersion":"SPDX-2.3"}'),
      provenance: Buffer.from(
        '{"predicateType":"https://slsa.dev/provenance/v1"}',
      ),
      conformanceEvidence: Buffer.from(
        JSON.stringify({
          schemaVersion: "vem-vision-conformance/v1",
          kind: "vision-release-conformance",
          bundleDigest: fixture.descriptor.bundle.digest,
          descriptorDigest: fixture.descriptor.identity,
          protocolVersion: "vem.vision.v1",
        }),
      ),
      approval: Buffer.from(JSON.stringify(fixture.approval)),
    });

    assert.equal(result.approved, false);
    assert.deepEqual(result.missing, []);
  });

  it("rejects arbitrary nonempty JSON objects as a release candidate", () => {
    const result = assessVisionReleaseCandidate({
      bundleDigest: digest(),
      bundleBytes: 1,
      descriptor: Buffer.from("{}"),
      attestation: Buffer.from("{}"),
      sbom: Buffer.from("{}"),
      provenance: Buffer.from("{}"),
      conformanceEvidence: Buffer.from("{}"),
      approval: Buffer.from("{}"),
    });

    assert.equal(result.approved, false);
    assert.deepEqual(result.missing, ["invalid-release-metadata"]);
  });
});
