import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRuntimeArtifactDescriptor,
  writeRuntimeArtifactDescriptor,
} from "./runtime-artifact-descriptor.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "vem-unified-delivery-"));
}

async function createRuntimeInput(root) {
  const runtime = join(root, "runtime-input");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "vending-daemon.exe"), "daemon\n");
  writeFileSync(join(runtime, "machine.exe"), "machine\n");
  writeFileSync(join(runtime, "WebView2Loader.dll"), "webview\n");
  const descriptor = await createRuntimeArtifactDescriptor({
    runtimeDirectory: runtime,
    commit: "1".repeat(40),
    artifactName: "windows-runtime-artifacts",
    workflowRunIdentity: "github-actions://ykdz/vem/actions/runs/1/attempts/1",
    toolchain: {
      runnerImage: "windows-2022",
      runnerImageVersion: "20250715.1",
      node: "24.16.0",
      pnpm: "11.9.0",
      rustc: "1.89.0",
      cargo: "1.89.0",
      tauriCli: "2.0.0",
    },
  });
  await writeRuntimeArtifactDescriptor(runtime, descriptor);
  return { runtime, descriptor };
}

function createVisionPreapproval(root, expectedDigest) {
  const preapproval = join(
    root,
    "vision-preapproval-input",
    "VEM-VISION-PREAPPROVAL",
  );
  mkdirSync(preapproval, { recursive: true });
  const files = {
    "bundle.bin": Buffer.from("bundle\n"),
    "vision-release-descriptor.json": Buffer.from(
      '{"schemaVersion":"fixture"}\n',
    ),
    "test-vision-candidate.ps1": Buffer.from("Write-Host test\n"),
    "vision-release-materialization.psm1": Buffer.from("Export-ModuleMember\n"),
    "vision-diagnostic-redaction.psm1": Buffer.from("Export-ModuleMember\n"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(preapproval, name), bytes);
  }
  const manifest = {
    schemaVersion: "vem-vision-preapproval-delivery/v1",
    kind: "vision-preapproval-delivery",
    expectedDigest,
    descriptorDigest: sha(files["vision-release-descriptor.json"]),
    files: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]),
    ),
  };
  writeFileSync(
    join(preapproval, "preapproval-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(preapproval, "SHA256SUMS"),
    Object.entries({
      ...files,
      "preapproval-manifest.json": Buffer.from(
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    })
      .map(([name, bytes]) => `${sha(bytes).slice(7)}  ${name}`)
      .sort()
      .join("\n") + "\n",
  );
  return preapproval;
}

function createVisionFactory(root, bundleDigest) {
  const out = join(root, "vision-factory-input");
  mkdirSync(join(out, "VEM", "VISION-RELEASE"), { recursive: true });
  mkdirSync(join(out, "VEM", "VISION-TRUST"), { recursive: true });
  mkdirSync(join(out, "VEM", "VISION-INSTALLER"), { recursive: true });
  writeFileSync(join(out, "VEM", "VISION-RELEASE", "bundle.bin"), "bundle\n");
  writeFileSync(
    join(out, "VEM", "VISION-INSTALLER", "install-vision-release.ps1"),
    "Write-Host install\n",
  );
  writeFileSync(
    join(
      out,
      "VEM",
      "VISION-INSTALLER",
      "provision-vision-factory-release.ps1",
    ),
    "Write-Host provision\n",
  );
  writeFileSync(
    join(out, "VEM", "VISION-INSTALLER", "vision-release-materialization.psm1"),
    "Export-ModuleMember\n",
  );
  writeFileSync(
    join(out, "VEM", "VISION-INSTALLER", "vision-diagnostic-redaction.psm1"),
    "Export-ModuleMember\n",
  );
  const files = {};
  for (const relative of [
    "VISION-RELEASE/bundle.bin",
    "VISION-INSTALLER/install-vision-release.ps1",
    "VISION-INSTALLER/provision-vision-factory-release.ps1",
    "VISION-INSTALLER/vision-release-materialization.psm1",
    "VISION-INSTALLER/vision-diagnostic-redaction.psm1",
  ]) {
    files[relative] = sha(
      readFileSync(join(out, "VEM", ...relative.split("/"))),
    );
  }
  writeFileSync(
    join(out, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
    `${canonicalJson({
      schemaVersion: "vem-vision-factory-provisioning/v1",
      kind: "vision-factory-provisioning",
      files,
    })}\n`,
  );
  writeFileSync(
    join(out, "experimental-acceptance.json"),
    `${JSON.stringify(
      {
        schemaVersion: "vem-vision-experimental-acceptance/v1",
        kind: "vision-experimental-acceptance",
        classification: "Experimental Candidate / Testbed Accepted",
        bundleDigest,
      },
      null,
      2,
    )}\n`,
  );
  return out;
}

test("prepare stages one exact delivery unit for managed update and progressive acceptance", async () => {
  const root = fixtureRoot();
  try {
    const { runtime } = await createRuntimeInput(root);
    const expectedVisionDigest = "sha256:" + "a".repeat(64);
    const preapproval = createVisionPreapproval(root, expectedVisionDigest);
    const visionFactory = createVisionFactory(root, expectedVisionDigest);
    const output = join(root, "out");
    const script = join(
      process.cwd(),
      "scripts/windows/prepare-unified-field-delivery.mjs",
    );
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [
      script,
      "prepare",
      "--output",
      output,
      "--update-id",
      "field-20260715T120000Z",
      "--runtime-directory",
      runtime,
      "--vision-preapproval-directory",
      preapproval,
      "--vision-factory-directory",
      visionFactory,
      "--expected-vision-bundle-digest",
      expectedVisionDigest,
    ]);
    const candidate = JSON.parse(
      readFileSync(join(output, "candidate.json"), "utf8"),
    );
    assert.equal(candidate.updateId, "field-20260715T120000Z");
    assert.equal(candidate.vision.bundleDigest, expectedVisionDigest);
    const manifest = JSON.parse(
      readFileSync(join(output, "managed-update.json"), "utf8"),
    );
    assert.equal(
      manifest.components[0].artifactPath,
      "C:\\VEM\\updates\\field-20260715T120000Z\\runtime\\vending-daemon.exe",
    );
    assert.equal(
      manifest.components[1].sidecars[0].targetPath,
      "C:\\VEM\\bringup\\WebView2Loader.dll",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare-preapproval stages the L3 delivery without Factory inputs", async () => {
  const root = fixtureRoot();
  try {
    const { runtime, descriptor } = await createRuntimeInput(root);
    const expectedVisionDigest = "sha256:" + "b".repeat(64);
    const preapproval = createVisionPreapproval(root, expectedVisionDigest);
    const output = join(root, "out");
    const script = join(
      process.cwd(),
      "scripts/windows/prepare-unified-field-delivery.mjs",
    );
    const { execFileSync } = await import("node:child_process");

    execFileSync(process.execPath, [
      script,
      "prepare-preapproval",
      "--output",
      output,
      "--update-id",
      "field-preapproval-20260715T120000Z",
      "--runtime-directory",
      runtime,
      "--vision-preapproval-directory",
      preapproval,
      "--expected-vision-bundle-digest",
      expectedVisionDigest,
    ]);

    assert.equal(existsSync(join(output, "vision-factory")), false);
    assert.equal(
      existsSync(
        join(
          output,
          "vision-preapproval",
          "VEM-VISION-PREAPPROVAL",
          "preapproval-manifest.json",
        ),
      ),
      true,
    );
    const stagedCandidate = JSON.parse(
      readFileSync(join(output, "candidate.json"), "utf8"),
    );
    assert.equal(stagedCandidate.vision.pythonVersion, "3.11.9");
    assert.equal(stagedCandidate.vision.experimentalAcceptanceDigest, null);

    const stagedManifest = JSON.parse(
      readFileSync(join(output, "managed-update.json"), "utf8"),
    );
    const runtimeByRole = Object.fromEntries(
      descriptor.artifacts.map((artifact) => [artifact.role, artifact]),
    );
    assert.equal(
      `sha256:${stagedManifest.components[0].sha256}`,
      runtimeByRole["vem-daemon"].digest,
    );
    assert.equal(
      `sha256:${stagedManifest.components[1].sha256}`,
      runtimeByRole["vem-machine-ui"].digest,
    );
    assert.equal(
      `sha256:${stagedManifest.components[1].sidecars[0].sha256}`,
      runtimeByRole["webview2-loader"].digest,
    );

    const stagedPreapprovalRoot = join(
      output,
      "vision-preapproval",
      "VEM-VISION-PREAPPROVAL",
    );
    const stagedPreapprovalManifest = JSON.parse(
      readFileSync(join(stagedPreapprovalRoot, "preapproval-manifest.json")),
    );
    assert.equal(
      sha(readFileSync(join(stagedPreapprovalRoot, "bundle.bin"))),
      stagedPreapprovalManifest.files["bundle.bin"],
    );

    const stagedSums = new Map(
      readFileSync(join(output, "SHA256SUMS"), "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [digest, relativePath] = line.split("  ");
          return [relativePath, `sha256:${digest}`];
        }),
    );
    assert.equal(
      stagedSums.get("runtime/vending-daemon.exe"),
      runtimeByRole["vem-daemon"].digest,
    );
    assert.equal(
      stagedSums.get("vision-preapproval/VEM-VISION-PREAPPROVAL/bundle.bin"),
      stagedPreapprovalManifest.files["bundle.bin"],
    );

    const applyInstructions = readFileSync(
      join(output, "APPLY-FIELD-UPDATE.ps1"),
      "utf8",
    );
    assert.doesNotMatch(
      applyInstructions,
      /provision-vision-factory-release|vision-factory/i,
    );
    assert.match(applyInstructions, /same exact runtime bytes/i);
    assert.match(applyInstructions, /same managed-update\.json/i);
    assert.match(applyInstructions, /do not create a second Vision installer/i);
    assert.match(applyInstructions, /does not claim Factory acceptance/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare-preapproval requires an operator-pinned Vision digest", async () => {
  const root = fixtureRoot();
  try {
    const { runtime } = await createRuntimeInput(root);
    const preapproval = createVisionPreapproval(
      root,
      "sha256:" + "c".repeat(64),
    );
    const script = join(
      process.cwd(),
      "scripts/windows/prepare-unified-field-delivery.mjs",
    );
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [
      script,
      "prepare-preapproval",
      "--output",
      join(root, "out"),
      "--update-id",
      "field-preapproval-20260715T130000Z",
      "--runtime-directory",
      runtime,
      "--vision-preapproval-directory",
      preapproval,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /expected vision bundle digest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skeleton records missing exact inputs without building source artifacts", async () => {
  const root = fixtureRoot();
  try {
    const output = join(root, "skeleton");
    const script = join(
      process.cwd(),
      "scripts/windows/prepare-unified-field-delivery.mjs",
    );
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [
      script,
      "skeleton",
      "--output",
      output,
      "--update-id",
      "field-20260715T120000Z",
      "--source-commit",
      "2".repeat(40),
    ]);
    const required = JSON.parse(
      readFileSync(join(output, "required-inputs.json"), "utf8"),
    );
    assert.match(
      required.missingExactInputs[0],
      /WINDOWS-RUNTIME-ARTIFACTS\.json/,
    );
    assert.match(
      readFileSync(join(output, "NEXT-STEPS.md"), "utf8"),
      /prepare-preapproval/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
