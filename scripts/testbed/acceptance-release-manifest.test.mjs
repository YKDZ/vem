import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  bindAcceptanceReleaseManifest,
  buildAcceptanceReleaseManifest,
  canonicalAcceptanceReleaseManifest,
} from "./acceptance-release-manifest.mjs";

function identity() {
  return {
    githubSha: "1".repeat(40),
    backend: {
      serviceApi: {
        build: { byteSize: 11, fileCount: 2, sha256: "2".repeat(64) },
        runtime: {
          database: "ok",
          entrypoint: "main.js",
          health: "ready",
          mqtt: "connected",
        },
      },
      adminUi: {
        build: { byteSize: 13, fileCount: 3, sha256: "3".repeat(64) },
        delivery: { buildVerified: true, entrypoint: "index.html" },
      },
    },
    runtimeArtifacts: {
      commit: "1".repeat(40),
      sourceDigest: "4".repeat(64),
      reusedFromCommitCache: false,
      reusedFromPass1: false,
      artifacts: {
        daemon: { sha256: "5".repeat(64) },
        machine: { sha256: "6".repeat(64) },
        webViewLoader: { sha256: "7".repeat(64) },
      },
    },
    visionCore: {
      sha256: "8".repeat(64),
      runtimeArchive: {
        byteSize: 17,
        sha256: "9".repeat(64),
        sourceCommit: "a".repeat(40),
      },
      recordedFixtureArchive: {
        byteSize: 19,
        sha256: "b".repeat(64),
        sourceCommit: "a".repeat(40),
      },
    },
    aiVirtualTryOn: {
      authority: {
        contract: {
          bundleDigest: "c".repeat(64),
          manifestSha256: "d".repeat(64),
          protocol: "vem.vision.v2",
        },
        candidate: {
          sourceCommit: "a".repeat(40),
          subjectSha256: "9".repeat(64),
        },
        resources: {
          aiLockSha256: "e".repeat(64),
          runtimeDescriptorSha256: "f".repeat(64),
          sourceDescriptorSha256: "0".repeat(64),
          workerExecutableSha256: "1".repeat(64),
        },
        modelPack: {
          archive: { byteSize: 23, sha256: "2".repeat(64) },
          descriptorSha256: "3".repeat(64),
          sourceRevision: "4".repeat(40),
        },
      },
      input: {
        manifestSha256: "5".repeat(64),
        modelPackArchive: { byteSize: 23, sha256: "2".repeat(64) },
        materializedModelPackRoot: {
          byteSize: 29,
          sha256: "6".repeat(64),
          members: [
            { name: "weights/model.bin", byteSize: 29, sha256: "7".repeat(64) },
          ],
        },
      },
    },
  };
}

test("builds one canonical acceptance release manifest from existing runtime identities", () => {
  const value = buildAcceptanceReleaseManifest(identity());
  const raw = canonicalAcceptanceReleaseManifest(value);
  assert.equal(
    value.schemaVersion,
    "vem-runtime-testbed-acceptance-release/v1",
  );
  assert.equal(value.vem.sourceCommit, "1".repeat(40));
  assert.equal(value.backend.serviceApi.runtime.health, "ready");
  assert.equal(value.windowsRuntime.artifacts.machine.sha256, "6".repeat(64));
  assert.equal(value.vision.runtimeArchive.sha256, "9".repeat(64));
  assert.equal(
    value.aiVirtualTryOn.authority.contract.bundleDigest,
    "c".repeat(64),
  );
  assert.equal(createHash("sha256").update(raw).digest("hex").length, 64);
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
});

test("refuses an incomplete release identity before it can become a manifest", () => {
  const incomplete = identity();
  delete incomplete.backend.adminUi.build.sha256;
  assert.throws(
    () => buildAcceptanceReleaseManifest(incomplete),
    /Admin UI build SHA-256 is invalid/,
  );
  const unbound = identity();
  unbound.aiVirtualTryOn.input.modelPackArchive.sha256 = "8".repeat(64);
  assert.throws(
    () => buildAcceptanceReleaseManifest(unbound),
    /model archive drifted from authority/,
  );
});

test("rejects a pass-two release identity that drifts from pass one", () => {
  const passA = identity();
  const passB = structuredClone(passA);
  passB.runtimeArtifacts.reusedFromPass1 = true;
  const bound = bindAcceptanceReleaseManifest(passA, passB);
  assert.match(bound.sha256, /^[a-f0-9]{64}$/);
  passB.aiVirtualTryOn.authority.resources.workerExecutableSha256 = "9".repeat(
    64,
  );
  assert.throws(
    () => bindAcceptanceReleaseManifest(passA, passB),
    /pass 2 drifted from pass 1/,
  );
});
