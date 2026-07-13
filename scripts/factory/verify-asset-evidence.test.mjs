import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  createSignedAssetEvidence,
  verifyAuthenticodeSignature,
  verifyAssetEvidence,
} from "./verify-asset-evidence.mjs";

const run = promisify(execFile);

const ASSET_DIGEST = `sha256:${"a".repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-evidence-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const created = createSignedAssetEvidence({
    assetDigest: ASSET_DIGEST,
    privateKey,
    sourceIdentity:
      "git+https://github.com/vem/vem@1111111111111111111111111111111111111111",
    builderIdentity:
      "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main",
    buildId: "github-actions://vem/vem/actions/runs/42/attempts/1",
  });
  await mkdir(join(root, "sha256"));
  for (const evidence of created.evidence) {
    await writeFile(
      join(root, "sha256", evidence.digest.slice(7)),
      evidence.bytes,
    );
  }
  return {
    root,
    asset: {
      digest: ASSET_DIGEST,
      signature: created.signature,
      provenance: created.provenance,
    },
    approvals: {
      signerIdentities: [created.signature.signerIdentity],
      builderIdentities: [created.provenance.builderIdentity],
      authenticodeSignerIdentities: [],
    },
  };
}

describe("asset signature and provenance evidence", () => {
  it("verifies detached signatures and signed provenance against approved identities", async () => {
    const data = await fixture();
    try {
      const verified = await verifyAssetEvidence({
        asset: data.asset,
        evidenceStoreRoot: data.root,
        approvalPolicy: data.approvals,
      });
      assert.equal(verified.signature.verified, true);
      assert.equal(verified.provenance.verified, true);
      assert.equal(
        verified.signature.evidenceDigest,
        data.asset.signature.evidenceDigest,
      );
      assert.equal(
        verified.provenance.evidenceDigest,
        data.asset.provenance.evidenceDigest,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("verifies embedded AuthentiCode evidence, trust chain, and approved leaf identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-authenticode-fixture-"));
    try {
      const source = join(root, "fixture.c");
      const unsigned = join(root, "unsigned.exe");
      const signed = join(root, "signed.exe");
      const key = join(root, "key.pem");
      const certificate = join(root, "certificate.pem");
      await writeFile(source, "int main(void) { return 0; }\n");
      await run("x86_64-w64-mingw32-gcc", [source, "-o", unsigned]);
      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-subj",
        "/CN=VEM Authenticode Fixture",
        "-days",
        "2",
      ]);
      await run("osslsigncode", [
        "sign",
        "-certs",
        certificate,
        "-key",
        key,
        "-h",
        "sha256",
        "-in",
        unsigned,
        "-out",
        signed,
      ]);
      const assetBytes = await readFile(signed);
      const digest = `sha256:${createHash("sha256").update(assetBytes).digest("hex")}`;
      const certificateIdentity = `x509-sha256:${createHash("sha256")
        .update(new X509Certificate(await readFile(certificate)).raw)
        .digest("hex")}`;
      const asset = {
        identity: `factory-cas://sha256/${digest.slice(7)}`,
        digest,
        signature: {
          scheme: "authenticode",
          signerIdentity: certificateIdentity,
          evidenceIdentity: `factory-cas://sha256/${digest.slice(7)}`,
          evidenceDigest: digest,
        },
      };
      const verifierDigest = `sha256:${createHash("sha256")
        .update(await readFile("/usr/bin/osslsigncode"))
        .digest("hex")}`;
      const verified = await verifyAuthenticodeSignature({
        asset,
        assetPath: signed,
        verifierPath: "/usr/bin/osslsigncode",
        verifierDigest,
        caBundlePath: certificate,
        approvedSignerIdentities: [certificateIdentity],
      });
      assert.equal(verified.verified, true);

      asset.signature.signerIdentity = `x509-sha256:${"b".repeat(64)}`;
      await assert.rejects(
        verifyAuthenticodeSignature({
          asset,
          assetPath: signed,
          verifierPath: "/usr/bin/osslsigncode",
          verifierDigest,
          caBundlePath: certificate,
          approvedSignerIdentities: [certificateIdentity],
        }),
        /approved signer/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects forged evidence, unapproved signers, and manifest/evidence claim drift", async () => {
    const data = await fixture();
    try {
      const signaturePath = join(
        data.root,
        "sha256",
        data.asset.signature.evidenceDigest.slice(7),
      );
      const bytes = Buffer.from(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(signaturePath),
        ),
      );
      bytes[bytes.length - 2] ^= 1;
      await writeFile(signaturePath, bytes);
      await assert.rejects(
        verifyAssetEvidence({
          asset: data.asset,
          evidenceStoreRoot: data.root,
          approvalPolicy: data.approvals,
        }),
        /evidence digest|signature/i,
      );

      const fresh = await fixture();
      try {
        await assert.rejects(
          verifyAssetEvidence({
            asset: fresh.asset,
            evidenceStoreRoot: fresh.root,
            approvalPolicy: {
              ...fresh.approvals,
              signerIdentities: ["spki-sha256:" + "b".repeat(64)],
            },
          }),
          /approved signer/i,
        );
        fresh.asset.provenance.buildId =
          "github-actions://vem/vem/actions/runs/99/attempts/1";
        await assert.rejects(
          verifyAssetEvidence({
            asset: fresh.asset,
            evidenceStoreRoot: fresh.root,
            approvalPolicy: fresh.approvals,
          }),
          /provenance.*buildId/i,
        );
      } finally {
        await rm(fresh.root, { recursive: true, force: true });
      }
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
