import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function powershellFunction(source, name) {
  const lines = source.slice(source.indexOf(`function ${name}`)).split("\n");
  const output = [];
  let depth = 0;
  for (const line of lines) {
    output.push(line);
    depth += (line.match(/{/g) ?? []).length;
    depth -= (line.match(/}/g) ?? []).length;
    if (depth === 0 && output.length > 1) break;
  }
  return output.join("\n");
}

async function runGuards(value, artifactText = "machine-runtime") {
  const root = await mkdtemp(join(tmpdir(), "vem-payment-secret-guard-"));
  try {
    const source = await readFile(
      "scripts/windows/apply-managed-update.ps1",
      "utf8",
    );
    const manifestPath = join(root, "manifest.json");
    const artifactPath = join(root, "machine.exe");
    const harnessPath = join(root, "guard.ps1");
    await writeFile(manifestPath, JSON.stringify(value), "utf8");
    await writeFile(artifactPath, artifactText, "utf8");
    await writeFile(
      harnessPath,
      `${powershellFunction(source, "Assert-NoPlatformPaymentSecrets")}\n${powershellFunction(source, "Assert-NoPlatformPaymentSecretFile")}\n$manifest = Get-Content -LiteralPath '${manifestPath}' -Raw | ConvertFrom-Json\nAssert-NoPlatformPaymentSecrets -Value $manifest -Path manifest\nAssert-NoPlatformPaymentSecretFile -Path '${artifactPath}'\n`,
      "utf8",
    );
    return spawnSync("pwsh", ["-NoProfile", "-File", harnessPath], {
      encoding: "utf8",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("managed-update payment secret guard", () => {
  it("accepts a normal delivery unit without platform credentials", async () => {
    const result = await runGuards({
      updateId: "field-1",
      components: [{ component: "ui", artifactPath: "machine.exe" }],
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects provider secret fields and PEM bytes", async () => {
    const secretField = await runGuards({ privateKeyPem: "secret" });
    assert.notEqual(secretField.status, 0);
    assert.match(secretField.stderr, /platform-only payment secret/i);

    const pemArtifact = await runGuards(
      { updateId: "field-2", components: [] },
      "-----BEGIN CERTIFICATE-----\nnot-deliverable\n",
    );
    assert.notEqual(pemArtifact.status, 0);
    assert.match(
      pemArtifact.stderr,
      /platform payment private-key or certificate/i,
    );
  });
});
