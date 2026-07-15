import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";

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

function storedZip(
  name,
  content,
  declaredSize = content.length,
  flags = 0,
  method = 0,
) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, content, central, fileName, end]);
}

function encryptedLocalHiddenByEmptyDirectory() {
  const name = Buffer.from("orphan-encrypted.bin");
  const content = Buffer.from("ciphertext");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x01, 6);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, end]);
}

function orphanEncryptedLocalAfterCentralDirectory() {
  const declared = storedZip("declared.txt", Buffer.from("safe"));
  const orphan = encryptedLocalHiddenByEmptyDirectory();
  return Buffer.concat([
    declared.subarray(0, -22),
    orphan.subarray(0, -22),
    declared.subarray(-22),
  ]);
}

function duplicateCentralEntry() {
  const declared = storedZip("duplicate.txt", Buffer.from("safe"));
  const endOffset = declared.length - 22;
  const centralStart = declared.readUInt32LE(endOffset + 16);
  const central = declared.subarray(centralStart, endOffset);
  const end = Buffer.from(declared.subarray(endOffset));
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(central.length * 2, 12);
  return Buffer.concat([
    declared.subarray(0, centralStart),
    central,
    central,
    end,
  ]);
}

function zip64Sentinel() {
  const declared = Buffer.from(storedZip("zip64.txt", Buffer.from("safe")));
  const endOffset = declared.length - 22;
  const centralStart = declared.readUInt32LE(endOffset + 16);
  declared.writeUInt32LE(0xffffffff, centralStart + 24);
  return declared;
}

async function runGuards(value, artifactBytes = "machine-runtime") {
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
    await writeFile(artifactPath, artifactBytes);
    await writeFile(
      harnessPath,
      `${powershellFunction(source, "Assert-NoPlatformPaymentSecretBytes")}\n${powershellFunction(source, "Assert-NoPlatformPaymentSecrets")}\n${powershellFunction(source, "Assert-NoPlatformPaymentSecretFile")}\n$manifest = Get-Content -LiteralPath '${manifestPath}' -Raw | ConvertFrom-Json\nAssert-NoPlatformPaymentSecrets -Value $manifest -Path manifest\nAssert-NoPlatformPaymentSecretFile -Path '${artifactPath}'\n`,
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

    const publicCertificate = await runGuards(
      { updateId: "field-ca", components: [] },
      "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----",
    );
    assert.equal(publicCertificate.status, 0, publicCertificate.stderr);
  });

  it("rejects provider secret fields and encoded private-key bytes", async () => {
    const secretField = await runGuards({ privateKeyPem: "secret" });
    assert.notEqual(secretField.status, 0);
    assert.match(secretField.stderr, /platform-only payment secret/i);

    const privatePem =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot-deliverable\n-----END ENCRYPTED PRIVATE KEY-----";
    for (const artifact of [
      privatePem,
      Buffer.from(privatePem, "utf16le"),
      Buffer.from(Buffer.from(privatePem).toString("base64")),
    ]) {
      const result = await runGuards(
        { updateId: "field-2", components: [] },
        artifact,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /platform private-key material/i);
    }

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const derArtifact = await runGuards(
      { updateId: "field-der", components: [] },
      privateKey.export({ format: "der", type: "pkcs8" }),
    );
    assert.notEqual(derArtifact.status, 0);
    assert.match(derArtifact.stderr, /platform private-key material/i);

    const encryptedDerArtifact = await runGuards(
      { updateId: "field-encrypted-der", components: [] },
      privateKey.export({
        format: "der",
        type: "pkcs8",
        cipher: "aes-256-cbc",
        passphrase: "terra-regression",
      }),
    );
    assert.notEqual(encryptedDerArtifact.status, 0);
    assert.match(encryptedDerArtifact.stderr, /platform private-key material/i);

    const zipArtifact = await runGuards(
      { updateId: "field-zip", components: [] },
      storedZip("nested/private.pem", Buffer.from(privatePem)),
    );
    assert.notEqual(zipArtifact.status, 0);
    assert.match(zipArtifact.stderr, /platform private-key material/i);

    const zipBomb = await runGuards(
      { updateId: "field-zip-bomb", components: [] },
      storedZip("bomb.bin", Buffer.alloc(1), 64 * 1024 * 1024),
    );
    assert.notEqual(zipBomb.status, 0);
    assert.match(zipBomb.stderr, /scan budget/i);

    const encryptedZip = await runGuards(
      { updateId: "field-encrypted-zip", components: [] },
      storedZip("encrypted.bin", Buffer.from("ciphertext"), 10, 0x01),
    );
    assert.notEqual(encryptedZip.status, 0);
    assert.match(encryptedZip.stderr, /encrypted archive/i);
  });

  it("scans every recursive manifest string for encoded private-key bytes", async () => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nmetadata-bypass\n-----END PRIVATE KEY-----";
    const result = await runGuards({
      updateId: "field-metadata",
      components: [],
      metadata: {
        releaseNote: Buffer.from(privatePem).toString("base64"),
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /platform private-key material/i);
  });

  it("fails closed when recursive base64 decoding exceeds the cumulative budget", async () => {
    const oneMiBCandidate = Buffer.alloc(1024 * 1024, 0xff).toString("base64");
    const result = await runGuards(
      { updateId: "field-base64-budget", components: [] },
      Array.from({ length: 17 }, () => oneMiBCandidate).join(":"),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scan budget/i);
  });

  it("rejects encrypted local entries hidden by an empty central directory", async () => {
    const result = await runGuards(
      { updateId: "field-hidden-local", components: [] },
      encryptedLocalHiddenByEmptyDirectory(),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive|encrypted archive/i);
  });

  it("rejects orphan encrypted local entries appended after the central directory", async () => {
    const result = await runGuards(
      { updateId: "field-orphan-local", components: [] },
      orphanEncryptedLocalAfterCentralDirectory(),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive|encrypted archive/i);
  });

  it("keeps valid deflate archives and rejects unverifiable ZIP structures", async () => {
    const plain = Buffer.from("valid deflate runtime payload");
    const valid = await runGuards(
      { updateId: "field-valid-deflate", components: [] },
      storedZip("runtime.txt", deflateRawSync(plain), plain.length, 0, 8),
    );
    assert.equal(valid.status, 0, valid.stderr);

    for (const malformed of [
      storedZip("descriptor.txt", Buffer.from("safe"), 4, 0x08),
      duplicateCentralEntry(),
      zip64Sentinel(),
    ]) {
      const result = await runGuards(
        { updateId: "field-malformed-zip", components: [] },
        malformed,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid archive|unsupported archive/i);
    }
  });
});
