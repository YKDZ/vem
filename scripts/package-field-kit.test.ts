import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { packageFieldKit } from "./package-field-kit.ts";

const roots: string[] = [];
afterEach(() => {
  // node:test cleans up roots at process end; keep the dir for failure inspection.
});

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

test("packages a field kit with verified members, zip, and fixed-size parts", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-field-kit-test-"));
  roots.push(root);
  const source = join(root, "source");
  const out = join(root, "out");
  const partsOut = join(root, "parts");
  for (const dir of [source, out, partsOut]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".keep"), "");
  }
  const make = (
    name: string,
    content: Buffer,
  ): { path: string; sha256: string } => {
    const path = join(source, name);
    writeFileSync(path, content);
    return { path, sha256: sha256(content) };
  };

  const daemon = make("vending-daemon.exe", Buffer.alloc(32, 1));
  const machine = make("machine.exe", Buffer.alloc(32, 2));
  const loader = make("WebView2Loader.dll", Buffer.alloc(16, 3));
  const visionZip = make("vision.zip", Buffer.alloc(64, 4));
  const modelPack = make("models.zip", Buffer.alloc(128, 5));
  const vemCommit = "a".repeat(40);
  const visionCommit = "b".repeat(40);
  const modelSha = modelPack.sha256;

  const runtimeManifestPath = join(source, "vem-runtime-artifacts.json");
  writeFileSync(
    runtimeManifestPath,
    `${JSON.stringify({
      schemaVersion: "vem-runtime-artifacts/v1",
      commit: "c".repeat(40),
      sourceDigest: "d".repeat(64),
      artifacts: {
        daemon: { path: daemon.path, sha256: daemon.sha256 },
        machine: { path: machine.path, sha256: machine.sha256 },
        webViewLoader: { path: loader.path, sha256: loader.sha256 },
      },
    })}\n`,
  );
  const visionManifestPath = join(source, "vending-vision-main-artifacts.json");
  writeFileSync(
    visionManifestPath,
    `${JSON.stringify({
      schemaVersion: "vending-vision-main-artifacts/v1",
      commit: visionCommit,
      runtime: { file: "vision.zip", sha256: visionZip.sha256 },
    })}\n`,
  );

  const result = packageFieldKit([
    "--vem-commit",
    vemCommit,
    "--runtime-source-digest",
    "d".repeat(64),
    "--runtime-dir",
    source,
    "--runtime-manifest",
    runtimeManifestPath,
    "--vision-manifest",
    visionManifestPath,
    "--model-pack",
    modelPack.path,
    "--model-pack-sha256",
    modelSha,
    "--out-dir",
    out,
    "--part-size-mb",
    "1",
  ]) as {
    zip: { name: string; byteSize: number; sha256: string };
    parts: { name: string; byteSize: number; sha256: string }[];
    members: { name: string; byteSize: number; sha256: string }[];
    outDir: string;
  };

  assert.equal(result.zip.name, `vem-field-kit-${vemCommit}.zip`);
  assert.equal(
    result.members.find((m) => m.name === "vending-daemon.exe")?.sha256,
    daemon.sha256,
  );
  assert.equal(
    result.members.find((m) => m.name === "vending-vision-ai-models.zip")
      ?.sha256,
    modelSha,
  );
  assert.ok(result.parts.length >= 1);
  assert.ok(result.parts[0].byteSize <= 1024 * 1024);
  assert.ok(existsSync(join(out, "verify-parts.cmd")));
  assert.ok(existsSync(join(out, result.zip.name)));
  const zipBytes = readFileSync(join(out, result.zip.name));
  assert.equal(sha256(zipBytes), result.zip.sha256);
});
