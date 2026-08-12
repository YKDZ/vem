import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalAiAcceptanceInputManifest,
  identicalAiAcceptanceInputSnapshot,
  materializeAiAcceptanceInputSnapshot,
  validateAiAcceptanceInputManifest,
} from "./ai-acceptance-input-provisioning.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function file(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return {
    hostPath: path,
    sha256: digest(content),
    byteSize: Buffer.byteLength(content),
  };
}

function directory(root, relative, entries) {
  const path = join(root, relative);
  mkdirSync(path, { recursive: true });
  const members = entries.map(([name, content]) => {
    mkdirSync(join(path, name, ".."), { recursive: true });
    writeFileSync(join(path, name), content);
    return {
      name,
      sha256: digest(content),
      byteSize: Buffer.byteLength(content),
    };
  });
  const byteSize = members.reduce((sum, member) => sum + member.byteSize, 0);
  const sha256 = digest(
    members
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((member) => `${member.name}\0${member.sha256}\0${member.byteSize}\n`)
      .join(""),
  );
  return {
    hostPath: path,
    sha256,
    byteSize,
    members,
  };
}

function manifest(root) {
  const candidateInput = directory(root, "candidate", [
    ["candidate.zip", "candidate"],
    ["candidate-manifest.json", "manifest"],
    ["github-build-provenance.sigstore.json", "provenance"],
    ["trusted-builder-evidence.json", "trusted"],
  ]);
  const windowsProofInput = directory(root, "windows-proof", [
    ["precutover-ai-proof.json", "proof"],
    ["precutover-ai-proof.sigstore.json", "proof-signature"],
    ["trusted-precutover-proof-evidence.json", "proof-trusted"],
  ]);
  const modelPack = {
    archive: file(root, "model-pack.zip", "model-pack"),
    materializedRoot: directory(root, "model-pack", [
      ["weights/model.bin", "weights"],
    ]),
    delivery: { kind: "host-local-cache" },
  };
  return {
    schemaVersion: "vem-runtime-testbed-ai-input/v2",
    candidateInput,
    windowsProofInput,
    approvedPrecutoverReceipt: file(
      root,
      "approved-receipt.json",
      '{"schemaVersion":"vem.precutover.ai.v2","trustStatus":"pending_final_aggregate_approval"}',
    ),
    calibratedRegionalPolicy: file(
      root,
      "calibrated-regional-policy.json",
      "{\"calibrationStatus\":\"calibrated_issue10\"}\n",
    ),
    calibrationReceipt: file(root, "calibration-receipt.json", "{}\n"),
    installedVisionRuntimeArchive: {
      ...file(root, "vision-runtime.zip", "vision-runtime"),
      sourceCommit: "a".repeat(40),
    },
    recordedFixtureArchive: file(root, "recorded-fixtures.zip", "fixtures"),
    modelPack,
  };
}

test("validates a canonical host-local AI acceptance input manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-"));
  try {
    const value = manifest(join(root, "normal"));
    const raw = canonicalAiAcceptanceInputManifest(value);
    const checked = await validateAiAcceptanceInputManifest(raw);
    assert.equal(checked.manifestSha256, digest(raw));
    assert.equal(checked.guestInput.modelPackSource, "host-local-cache");
    assert.equal(
      checked.guestInput.candidateInputDirectory,
      `C:\\ProgramData\\VEM\\testbed\\ai-inputs\\${checked.manifestSha256}\\candidate`,
    );
    assert.equal(checked.transfers.length, 9);
    assert.deepEqual(
      checked.transfers.map((transfer) => transfer.guestPath),
      [
        checked.guestInput.candidateInputDirectory,
        checked.guestInput.windowsProofInputDirectory,
        checked.guestInput.approvedPrecutoverReceipt,
        checked.guestInput.calibratedRegionalPolicy,
        checked.guestInput.calibrationReceipt,
        checked.guestInput.installedVisionRuntimeArchive,
        checked.guestInput.recordedFixtureArchive,
        checked.guestInput.modelPackArchive,
        checked.guestInput.materializedModelPackRoot,
      ],
    );
    assert.equal(JSON.stringify(checked.guestInput).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializes immutable host-local inputs and derives every guest path", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-snapshot-"));
  try {
    const checked = await validateAiAcceptanceInputManifest(
      canonicalAiAcceptanceInputManifest(manifest(join(root, "source"))),
    );
    const snapshot = await materializeAiAcceptanceInputSnapshot(
      checked,
      join(root, "snapshots"),
    );
    assert.notEqual(
      snapshot.transfers[0].hostPath,
      checked.transfers[0].hostPath,
    );
    assert.match(snapshot.transfers[0].hostPath, /snapshots/);
    assert.match(
      snapshot.guestInput.inputRoot,
      /^C:\\ProgramData\\VEM\\testbed\\ai-inputs\\[a-f0-9]{64}$/,
    );
    assert.equal(
      JSON.stringify(snapshot.guestInput).includes(join(root, "source")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-pass input snapshots reject any manifest or artifact drift", () => {
  const base = {
    manifestSha256: "1".repeat(64),
    artifactDigests: {
      modelPackArchive: { sha256: "2".repeat(64), byteSize: 7 },
    },
  };
  assert.equal(
    identicalAiAcceptanceInputSnapshot(base, structuredClone(base)),
    true,
  );
  assert.equal(
    identicalAiAcceptanceInputSnapshot(base, {
      ...base,
      artifactDigests: {
        modelPackArchive: { sha256: "3".repeat(64), byteSize: 7 },
      },
    }),
    false,
  );
  assert.equal(
    identicalAiAcceptanceInputSnapshot(base, {
      ...base,
      manifestSha256: "4".repeat(64),
    }),
    false,
  );
});

test("rejects missing, extra, noncanonical, mismatched, and symlinked inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-invalid-"));
  try {
    const value = manifest(root);
    await assert.rejects(
      validateAiAcceptanceInputManifest(JSON.stringify(value)),
      /canonical/,
    );
    const missing = structuredClone(manifest(join(root, "missing")));
    missing.candidateInput.members.pop();
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(missing),
      ),
      /candidate exact-four/,
    );
    const extra = structuredClone(manifest(join(root, "extra")));
    extra.windowsProofInput.members.push({
      name: "extra.json",
      sha256: digest("extra"),
      byteSize: 5,
    });
    writeFileSync(
      join(extra.windowsProofInput.hostPath, "extra.json"),
      "extra",
    );
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(extra),
      ),
      /exact-three/,
    );
    const mismatched = structuredClone(manifest(join(root, "mismatched")));
    mismatched.recordedFixtureArchive.sha256 = "0".repeat(64);
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(mismatched),
      ),
      /SHA-256 mismatch/,
    );
    const duplicateGuestPath = structuredClone(
      manifest(join(root, "path-traversal")),
    );
    duplicateGuestPath.modelPack.archive.guestPath = "C:\\outside";
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(duplicateGuestPath),
      ),
      /fields are invalid/,
    );
    const linked = structuredClone(manifest(join(root, "linked")));
    const target = join(root, "linked-target.zip");
    writeFileSync(target, "target");
    const link = join(root, "linked-fixtures.zip");
    symlinkSync(target, link);
    linked.recordedFixtureArchive = {
      hostPath: link,
      guestPath: linked.recordedFixtureArchive.guestPath,
      sha256: digest("target"),
      byteSize: 6,
    };
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(linked),
      ),
      /regular file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
