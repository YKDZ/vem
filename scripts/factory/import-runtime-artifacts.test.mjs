import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { importRuntimeArtifacts } from "./import-runtime-artifacts.mjs";
import {
  createRuntimeArtifactDescriptor,
  validateRuntimeArtifactDescriptor,
  writeRuntimeArtifactDescriptor,
} from "./runtime-artifact-descriptor.mjs";

const COMMIT = "1".repeat(40);
const WORKFLOW_RUN = "github-actions://vem/vem/actions/runs/42/attempts/1";

function reference(role, bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    role,
    identity: `factory-cas://sha256/${hash}`,
    digest: `sha256:${hash}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-runtime-import-"));
  const runtimeDirectory = join(root, "runtime");
  await mkdir(runtimeDirectory);
  const definitions = [
    ["vem-daemon", "vending-daemon.exe", Buffer.from("daemon\n")],
    ["vem-machine-ui", "machine.exe", Buffer.from("machine\n")],
    ["webview2-loader", "WebView2Loader.dll", Buffer.from("webview\n")],
  ];
  for (const [, name, bytes] of definitions) {
    await writeFile(join(runtimeDirectory, name), bytes);
  }
  const descriptor = await createRuntimeArtifactDescriptor({
    runtimeDirectory,
    commit: COMMIT,
    artifactName: "windows-runtime-42",
    workflowRunIdentity: WORKFLOW_RUN,
    toolchain: {
      runnerImage: "windows-2022",
      runnerImageVersion: "20260701.1.0",
      node: "24.16.0",
      pnpm: "11.9.0",
      rustc: "1.96.0",
      cargo: "1.96.0",
      tauriCli: "2.9.5",
    },
  });
  await writeRuntimeArtifactDescriptor(runtimeDirectory, descriptor);
  return {
    root,
    runtimeDirectory,
    descriptor,
    manifest: {
      assets: definitions.map(([role, , bytes]) => reference(role, bytes)),
    },
  };
}

function expected(data) {
  return {
    artifactIdentity: data.descriptor.identity,
    artifactName: data.descriptor.workflow.artifactName,
    commit: COMMIT,
    workflowRunIdentity: WORKFLOW_RUN,
  };
}

describe("Windows runtime artifact importer", () => {
  it("binds descriptor identity, workflow outputs, exact files, and manifest assets", async () => {
    const data = await fixture();
    try {
      const result = await importRuntimeArtifacts({
        manifest: data.manifest,
        runtimeDirectory: data.runtimeDirectory,
        store: new ContentAddressedAssetStore(join(data.root, "cas")),
        expected: expected(data),
      });
      assert.equal(result.descriptorIdentity, data.descriptor.identity);
      assert.equal(result.imported.length, 3);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("hashes every downloaded source even when the matching CAS entry already exists", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(join(data.root, "cas"));
      const daemon = data.manifest.assets[0];
      await store.ensure(
        daemon,
        join(data.runtimeDirectory, "vending-daemon.exe"),
      );
      await writeFile(
        join(data.runtimeDirectory, "vending-daemon.exe"),
        "tampered\n",
      );
      await assert.rejects(
        importRuntimeArtifacts({
          manifest: data.manifest,
          runtimeDirectory: data.runtimeDirectory,
          store,
          expected: expected(data),
        }),
        /digest|bytes/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched workflow outputs and extra upload files", async () => {
    const data = await fixture();
    try {
      await assert.rejects(
        importRuntimeArtifacts({
          manifest: data.manifest,
          runtimeDirectory: data.runtimeDirectory,
          store: new ContentAddressedAssetStore(join(data.root, "cas-a")),
          expected: { ...expected(data), commit: "2".repeat(40) },
        }),
        /commit/i,
      );
      await writeFile(
        join(data.runtimeDirectory, "unexpected.pdb"),
        "debug symbols\n",
      );
      await assert.rejects(
        importRuntimeArtifacts({
          manifest: data.manifest,
          runtimeDirectory: data.runtimeDirectory,
          store: new ContentAddressedAssetStore(join(data.root, "cas-b")),
          expected: expected(data),
        }),
        /unexpected|allowlist/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects descriptor entries beyond the upload size ceiling", async () => {
    const data = await fixture();
    try {
      const oversized = structuredClone(data.descriptor);
      oversized.artifacts[0].bytes = 256 * 1024 * 1024 + 1;
      assert.throws(
        () => validateRuntimeArtifactDescriptor(oversized),
        /digest\/bytes|size limit/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
