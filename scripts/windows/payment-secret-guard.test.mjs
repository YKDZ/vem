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
  localExtra = Buffer.alloc(0),
  centralExtra = localExtra,
  archiveComment = Buffer.alloc(0),
  checksum = method === 0 ? crc32(content) : 0,
) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(localExtra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  const centralOffset =
    local.length + fileName.length + localExtra.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length + centralExtra.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(archiveComment.length, 20);
  return Buffer.concat([
    local,
    fileName,
    localExtra,
    content,
    central,
    fileName,
    centralExtra,
    end,
    archiveComment,
  ]);
}

function deflatedZip(name, content, declaredSize = content.length) {
  return storedZip(
    name,
    deflateRawSync(content),
    declaredSize,
    0,
    8,
    Buffer.alloc(0),
    Buffer.alloc(0),
    Buffer.alloc(0),
    crc32(content),
  );
}

function centralEntryOnAnotherDisk() {
  const archive = Buffer.from(storedZip("runtime.txt", Buffer.from("safe")));
  const endOffset = archive.length - 22;
  const centralStart = archive.readUInt32LE(endOffset + 16);
  archive.writeUInt16LE(1, centralStart + 34);
  return archive;
}

function deflatedZipWithWrongChecksum(name, content) {
  const archive = Buffer.from(deflatedZip(name, content));
  const endOffset = archive.length - 22;
  const centralStart = archive.readUInt32LE(endOffset + 16);
  const wrongChecksum = (crc32(content) ^ 0xffffffff) >>> 0;
  archive.writeUInt32LE(wrongChecksum, 14);
  archive.writeUInt32LE(wrongChecksum, centralStart + 16);
  return archive;
}

function concatenatedDeflateZip() {
  const first = Buffer.from("first neutral runtime payload");
  const compressed = Buffer.concat([
    deflateRawSync(first),
    deflateRawSync(Buffer.from("second neutral runtime payload")),
  ]);
  return storedZip(
    "concatenated-deflate.bin",
    compressed,
    first.length,
    0,
    8,
    Buffer.alloc(0),
    Buffer.alloc(0),
    Buffer.alloc(0),
    crc32(first),
  );
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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

function prefixedReadableZip(content) {
  const compressed = deflateRawSync(content);
  const declared = storedZip(
    "nested/private.pem",
    compressed,
    content.length,
    0,
    8,
  );
  const endOffset = declared.length - 22;
  const centralStart = declared.readUInt32LE(endOffset + 16);
  const checksum = crc32(content);
  declared.writeUInt32LE(checksum, 14);
  declared.writeUInt32LE(checksum, centralStart + 16);
  const prefixed = Buffer.concat([Buffer.from([0x4d]), declared]);
  prefixed.writeUInt32LE(1, centralStart + 1 + 42);
  prefixed.writeUInt32LE(centralStart + 1, endOffset + 1 + 16);
  return prefixed;
}

function prefixedZipWithUnadjustedOffsets(content) {
  return Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x56, 0x45, 0x4d]),
    deflatedZip("nested/private.pem", content),
  ]);
}

function prefixedMultiDiskZip(content) {
  const archive = prefixedZipWithUnadjustedOffsets(content);
  const endOffset = archive.length - 22;
  archive.writeUInt16LE(1, endOffset + 4);
  archive.writeUInt16LE(1, endOffset + 6);
  return archive;
}

function prefixedZip64Sentinel(content) {
  const archive = prefixedZipWithUnadjustedOffsets(content);
  const endOffset = archive.length - 22;
  archive.writeUInt16LE(0xffff, endOffset + 8);
  archive.writeUInt16LE(0xffff, endOffset + 10);
  return archive;
}

function prefixedZipWithOrphanLocal(content) {
  const prefix = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x56, 0x45, 0x4d]);
  const archive = deflatedZip("nested/runtime.bin", content);
  const orphan = encryptedLocalHiddenByEmptyDirectory().subarray(0, -22);
  return Buffer.concat([
    prefix,
    archive.subarray(0, -22),
    orphan,
    archive.subarray(-22),
  ]);
}

function prefixedZipWithCorruptFiniteCentralSize(content) {
  const archive = prefixedZipWithUnadjustedOffsets(content);
  const endOffset = archive.length - 22;
  archive.writeUInt32LE(
    archive.readUInt32LE(endOffset + 12) + 1,
    endOffset + 12,
  );
  return archive;
}

function nestedBase64Payload(layers) {
  let payload = Buffer.from("neutral nested runtime payload with separators");
  for (let layer = 0; layer < layers; layer += 1) {
    payload = Buffer.from(payload.toString("base64"));
  }
  return payload;
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

  it("fails closed when a Base64 candidate exceeds the recursion depth", async () => {
    const result = await runGuards(
      { updateId: "field-depth-limit", components: [] },
      nestedBase64Payload(4),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bounded platform private-key/i);
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
      deflatedZip("runtime.txt", plain),
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

  it("rejects dishonest deflate lengths and actual decoded budget overflow", async () => {
    const dishonest = await runGuards(
      { updateId: "field-dishonest-small", components: [] },
      deflatedZip(
        "dishonest-small.bin",
        Buffer.from("neutral runtime payload with a hidden tail"),
        1,
      ),
    );
    assert.notEqual(dishonest.status, 0);
    assert.match(
      dishonest.stderr,
      /invalid archive|scan budget|cannot be scanned safely/i,
    );

    const wrongChecksum = await runGuards(
      { updateId: "field-wrong-checksum", components: [] },
      deflatedZipWithWrongChecksum(
        "wrong-checksum.bin",
        Buffer.from("neutral runtime payload"),
      ),
    );
    assert.notEqual(wrongChecksum.status, 0);
    assert.match(
      wrongChecksum.stderr,
      /invalid archive|cannot be scanned safely/i,
    );

    const overflow = await runGuards(
      { updateId: "field-actual-overflow", components: [] },
      deflatedZip(
        "actual-overflow.bin",
        Buffer.alloc(16 * 1024 * 1024 + 1, 0x61),
        1,
      ),
    );
    assert.notEqual(overflow.status, 0);
    assert.match(
      overflow.stderr,
      /invalid archive|scan budget|cannot be scanned safely/i,
    );
  });

  it("rejects a central entry assigned to another disk", async () => {
    const result = await runGuards(
      { updateId: "field-multi-disk-entry", components: [] },
      centralEntryOnAnotherDisk(),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive|unsupported archive/i);
  });

  it("rejects concatenated raw deflate streams inside one compressed range", async () => {
    const result = await runGuards(
      { updateId: "field-concatenated-deflate", components: [] },
      concatenatedDeflateZip(),
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /invalid archive|unsupported archive|cannot be scanned safely/i,
    );
  });

  it("rejects a readable deflate ZIP container with a nonzero local-header offset", async () => {
    const privateKey = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nprefixed-secret\n-----END PRIVATE KEY-----",
    );
    const result = await runGuards(
      { updateId: "field-prefixed-zip", components: [] },
      prefixedReadableZip(privateKey),
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive|private-key material/i);
  });

  it("rejects a prefixed ZIP whose offsets remain relative to the archive start", async () => {
    const privateKey = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nunadjusted-prefix-secret\n-----END PRIVATE KEY-----",
    );
    const result = await runGuards(
      { updateId: "field-unadjusted-prefixed-zip", components: [] },
      prefixedZipWithUnadjustedOffsets(privateKey),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive|private-key material/i);
  });

  it("rejects a prefixed multidisk-shaped ZIP before trusting disk fields", async () => {
    const result = await runGuards(
      { updateId: "field-prefixed-multidisk", components: [] },
      prefixedMultiDiskZip(Buffer.from("neutral prefixed multidisk payload")),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive/i);
  });

  it("rejects a prefixed ZIP64-shaped archive before trusting sentinel fields", async () => {
    const result = await runGuards(
      { updateId: "field-prefixed-zip64", components: [] },
      prefixedZip64Sentinel(Buffer.from("neutral prefixed ZIP64 payload")),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive/i);
  });

  it("rejects a prefixed ZIP-shaped archive with an orphan local record", async () => {
    const result = await runGuards(
      { updateId: "field-prefixed-orphan", components: [] },
      prefixedZipWithOrphanLocal(Buffer.from("neutral orphan payload")),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive/i);
  });

  it("rejects a prefixed ZIP-shaped archive with corrupt finite central size", async () => {
    const result = await runGuards(
      { updateId: "field-prefixed-central-size", components: [] },
      prefixedZipWithCorruptFiniteCentralSize(
        Buffer.from("neutral finite metadata payload"),
      ),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid archive/i);
  });

  it("rejects recognizable ZIP trailing structures without flagging incidental PK bytes", async () => {
    const trailing = await runGuards(
      { updateId: "field-trailing-zip", components: [] },
      Buffer.concat([
        storedZip("runtime.txt", Buffer.from("safe")),
        Buffer.from("trailing-polyglot"),
      ]),
    );
    assert.notEqual(trailing.status, 0);
    assert.match(trailing.stderr, /invalid archive/i);

    const incidental = await runGuards(
      { updateId: "field-incidental-pk", components: [] },
      Buffer.from("ordinary PK\u0003\u0004 noise PK\u0005\u0006 bytes"),
    );
    assert.equal(incidental.status, 0, incidental.stderr);

    const allowedExtra = Buffer.from([0xfe, 0xca, 0x02, 0x00, 0x12, 0x34]);
    const commented = await runGuards(
      { updateId: "field-commented-zip", components: [] },
      storedZip(
        "metadata.txt",
        Buffer.from("safe"),
        4,
        0,
        0,
        allowedExtra,
        allowedExtra,
        Buffer.from("factory-comment"),
      ),
    );
    assert.equal(commented.status, 0, commented.stderr);
  });
});
