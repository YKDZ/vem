import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { createRedistributableFixtureIso } from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { createFactoryManifest } from "./factory-manifest.mjs";
import { createSignedAssetEvidence } from "./verify-asset-evidence.mjs";

const run = promisify(execFile);
const ISO_BUILDER_PATH = "/usr/bin/genisoimage";
const IMAGE_HASH = "f".repeat(64);
const BUILDER_IDENTITY =
  "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-cli-"));
  const isoBuilderHash = createHash("sha256")
    .update(await readFile(ISO_BUILDER_PATH))
    .digest("hex");
  const isoBuilder = {
    identity: `tool://genisoimage@sha256:${isoBuilderHash}`,
    digest: `sha256:${isoBuilderHash}`,
    version: "1.1.11",
  };
  const sourceIso = join(root, "fixture-source.iso");
  await createRedistributableFixtureIso({
    isoBuilderPath: ISO_BUILDER_PATH,
    isoBuilder,
    outputPath: sourceIso,
  });
  const bytesByRole = new Map([
    ["windows-source-iso", await readFile(sourceIso)],
    ["openssh-installer", Buffer.from("openssh\n")],
    ["wireguard-installer", Buffer.from("wireguard\n")],
    ["vem-daemon", Buffer.from("daemon\n")],
    ["vem-machine-ui", Buffer.from("machine\n")],
    ["webview2-loader", Buffer.from("webview\n")],
    ["vision-release", Buffer.from("vision\n")],
  ]);
  const evidenceStore = join(root, "evidence");
  await mkdir(join(evidenceStore, "sha256"), { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const definitions = [];
  for (const [role, bytes] of bytesByRole) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const signed = createSignedAssetEvidence({
      assetDigest: `sha256:${hash}`,
      privateKey,
      sourceIdentity: `git+https://github.com/vem/fixtures@${"1".repeat(40)}#${role}`,
      builderIdentity: BUILDER_IDENTITY,
      buildId: "github-actions://vem/vem/actions/runs/42/attempts/1",
    });
    for (const evidence of signed.evidence) {
      await writeFile(
        join(evidenceStore, "sha256", evidence.digest.slice(7)),
        evidence.bytes,
      );
    }
    definitions.push({
      role,
      identity: `factory-cas://sha256/${hash}`,
      digest: `sha256:${hash}`,
      version: role === "windows-source-iso" ? "10.0.19045" : "1.0.0",
      signature: signed.signature,
      provenance: signed.provenance,
      bytes,
    });
  }
  const builderImage = {
    identity: `oci://builder@sha256:${IMAGE_HASH}`,
    digest: `sha256:${IMAGE_HASH}`,
    version: "1.0.0",
  };
  const strip = ({ bytes, ...value }) => value;
  const manifest = createFactoryManifest({
    schemaVersion: "vem-factory-manifest/v1",
    kind: "factory-manifest",
    profile: "testbed",
    source: { windowsMedia: strip(definitions[0]) },
    assets: definitions.slice(1).map(strip),
    toolchain: { builderImage, isoBuilder },
    outputPolicy: {
      isoFileName: "vem-factory-{manifestId}.iso",
      reproducible: true,
      includeProvenance: true,
      assemblyMode: "bootable-fixture-envelope",
    },
  });
  const manifestStore = join(root, "manifests");
  const assetStoreRoot = join(root, "assets");
  const sourceStoreRoot = join(root, "windows-source");
  await mkdir(join(manifestStore, "sha256"), { recursive: true });
  await mkdir(join(sourceStoreRoot, "sha256"), { recursive: true });
  await writeFile(
    join(manifestStore, "sha256", `${manifest.manifestId.slice(7)}.json`),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(
      sourceStoreRoot,
      "sha256",
      manifest.source.windowsMedia.digest.slice(7),
    ),
    definitions[0].bytes,
  );
  const store = new ContentAddressedAssetStore(assetStoreRoot);
  for (const definition of definitions.slice(1)) {
    const source = join(root, `${definition.role}.bin`);
    await writeFile(source, definition.bytes);
    await store.ensure(definition, source);
  }
  const approvalPolicy = join(root, "approval-policy.json");
  await writeFile(
    approvalPolicy,
    JSON.stringify({
      signerIdentities: [definitions[0].signature.signerIdentity],
      builderIdentities: [BUILDER_IDENTITY],
      authenticodeSignerIdentities: [],
    }),
  );
  return {
    root,
    manifest,
    manifestStore,
    assetStoreRoot,
    sourceStoreRoot,
    evidenceStore,
    approvalPolicy,
    builderImage,
  };
}

describe("Factory builder CLI fixture", () => {
  it("loads logical identities, verifies host policy/toolchain, and writes sanitized result", async () => {
    const data = await fixture();
    try {
      const outputDirectory = join(data.root, "output");
      const result = await run(
        process.execPath,
        [
          "scripts/factory/factory-cli.mjs",
          "--manifest-store",
          data.manifestStore,
          "--asset-store",
          data.assetStoreRoot,
          "--output-dir",
          outputDirectory,
          "--windows-source-store",
          data.sourceStoreRoot,
          "--evidence-store",
          data.evidenceStore,
          "--approval-policy",
          data.approvalPolicy,
          "--iso-builder",
          ISO_BUILDER_PATH,
          "--manifest-identity",
          data.manifest.manifestId,
          "--reproducibility",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            VEM_FACTORY_EXECUTED_BUILDER_IMAGE: data.builderImage.identity,
          },
        },
      );
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.manifestIdentity, data.manifest.manifestId);
      assert.match(
        parsed.isoIdentity,
        /^factory-cas:\/\/sha256\/[a-f0-9]{64}$/,
      );
      assert.equal(
        parsed.provenanceIdentity,
        `factory-evidence://${parsed.provenanceDigest.replace(":", "/")}`,
      );
      assert.equal(result.stdout.includes(data.root), false);
      const provenance = JSON.parse(
        await readFile(
          join(outputDirectory, "factory-provenance.json"),
          "utf8",
        ),
      );
      assert.equal(provenance.evidence.cache.hits, 6);
      assert.equal(provenance.evidence.sourceMedia.cached, false);
      assert.equal(provenance.evidence.policy.hostPathsIncluded, false);
      const outputResolution = await new ContentAddressedAssetStore(
        data.assetStoreRoot,
      ).resolve({
        role: "factory-iso",
        identity: parsed.isoIdentity,
        digest: parsed.isoDigest,
      });
      assert.equal(outputResolution.status, "hit");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
