import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  assertNoPlatformPrivateKeyMaterial,
  assertNoPlatformPrivateKeyMaterialFile,
} from "../security/platform-private-key-scanner.mjs";

function storedZip(
  name,
  content,
  declaredUncompressedSize = content.length,
  flags = 0,
  method = 0,
  localExtra = Buffer.alloc(0),
  centralExtra = localExtra,
  archiveComment = Buffer.alloc(0),
  checksum = method === 0 ? crc32(content) : 0,
) {
  const fileName = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(declaredUncompressedSize, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(localExtra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(declaredUncompressedSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  const centralOffset =
    header.length + fileName.length + localExtra.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length + centralExtra.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(archiveComment.length, 20);
  return Buffer.concat([
    header,
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

function deflatedZipWithWrongChecksum(name, content) {
  const archive = Buffer.from(deflatedZip(name, content));
  const endOffset = archive.length - 22;
  const centralStart = archive.readUInt32LE(endOffset + 16);
  const wrongChecksum = (crc32(content) ^ 0xffffffff) >>> 0;
  archive.writeUInt32LE(wrongChecksum, 14);
  archive.writeUInt32LE(wrongChecksum, centralStart + 16);
  return archive;
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

describe("Factory runtime payment secret boundary", () => {
  it("allows ordinary public certificates but rejects private-key PEM encodings", () => {
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(
        Buffer.from("ordinary machine runtime"),
        "vem-machine-ui",
      ),
    );
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(
        Buffer.from(
          "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----",
        ),
        "public-ca.pem",
      ),
    );
    for (const text of [
      "-----BEGIN PRIVATE KEY-----\nplatform-key",
      "-----BEGIN RSA PRIVATE KEY-----\nplatform-key",
      "-----BEGIN EC PRIVATE KEY-----\nplatform-key",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nplatform-key",
    ]) {
      assert.throws(
        () => assertNoPlatformPrivateKeyMaterial(Buffer.from(text), "payload"),
        /private-key material/i,
      );
      assert.throws(() =>
        assertNoPlatformPrivateKeyMaterial(
          Buffer.from(text, "utf16le"),
          "utf16-payload",
        ),
      );
      assert.throws(() =>
        assertNoPlatformPrivateKeyMaterial(
          Buffer.from(Buffer.from(text).toString("base64")),
          "base64-payload",
        ),
      );
    }
  });

  it("rejects binary DER private keys without mistaking public DER for private material", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const encryptedPrivateDer = privateKey.export({
      format: "der",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "terra-regression",
    });
    const publicDer = publicKey.export({ format: "der", type: "spki" });

    assert.throws(
      () => assertNoPlatformPrivateKeyMaterial(privateDer, "private.der"),
      /private-key material/i,
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          encryptedPrivateDer,
          "opaque-runtime-payload.bin",
        ),
      /private-key material/i,
    );
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(publicDer, "public.der"),
    );
  });

  it("rejects a real PKCS#12 container carrying a private key", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-private-key-pkcs12-"));
    try {
      const key = join(root, "key.pem");
      const cert = join(root, "cert.pem");
      const certDer = join(root, "cert.der");
      const bundle = join(root, "bundle.p12");
      const created = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-subj",
          "/CN=VEM scanner fixture",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { encoding: "utf8" },
      );
      assert.equal(created.status, 0, created.stderr);
      const converted = spawnSync(
        "openssl",
        ["x509", "-in", cert, "-outform", "der", "-out", certDer],
        { encoding: "utf8" },
      );
      assert.equal(converted.status, 0, converted.stderr);
      const certificateBytes = await readFile(certDer);
      assert.doesNotThrow(() =>
        assertNoPlatformPrivateKeyMaterial(
          certificateBytes,
          "public-certificate.der",
        ),
      );
      const exported = spawnSync(
        "openssl",
        [
          "pkcs12",
          "-export",
          "-inkey",
          key,
          "-in",
          cert,
          "-out",
          bundle,
          "-passout",
          "pass:",
        ],
        { encoding: "utf8" },
      );
      assert.equal(exported.status, 0, exported.stderr);
      const bundleBytes = await readFile(bundle);
      assert.throws(
        () =>
          assertNoPlatformPrivateKeyMaterial(
            bundleBytes,
            "provider-credentials.p12",
          ),
        /private-key material/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scans archive entries with a bounded expansion budget", () => {
    const privateKey = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\narchive-secret\n-----END PRIVATE KEY-----",
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          storedZip("nested/private.pem", privateKey),
          "vision-release.zip",
        ),
      /private-key material/i,
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          storedZip("bomb.bin", Buffer.alloc(1), 64 * 1024 * 1024),
          "oversized.zip",
        ),
      /scan budget/i,
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          storedZip("encrypted.bin", Buffer.from("ciphertext"), 10, 0x01),
          "encrypted.zip",
        ),
      /encrypted archive/i,
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          encryptedLocalHiddenByEmptyDirectory(),
          "empty-directory-bypass.zip",
        ),
      /invalid archive|encrypted archive/i,
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          orphanEncryptedLocalAfterCentralDirectory(),
          "orphan-after-central.zip",
        ),
      /invalid archive|encrypted archive/i,
    );
    const deflated = Buffer.from("valid deflate runtime payload");
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(
        deflatedZip("runtime.txt", deflated),
        "valid-deflate.zip",
      ),
    );
    for (const malformed of [
      storedZip("descriptor.txt", Buffer.from("safe"), 4, 0x08),
      duplicateCentralEntry(),
      zip64Sentinel(),
    ]) {
      assert.throws(
        () => assertNoPlatformPrivateKeyMaterial(malformed, "malformed.zip"),
        /invalid archive|unsupported archive/i,
      );
    }
  });

  it("rejects dishonest deflate lengths and actual decoded budget overflow", () => {
    const neutralTail = Buffer.from(
      "neutral runtime payload with a hidden tail",
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          deflatedZip("dishonest-small.bin", neutralTail, 1),
          "dishonest-small.zip",
        ),
      /invalid archive|scan budget/i,
    );

    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          deflatedZip(
            "actual-overflow.bin",
            Buffer.alloc(16 * 1024 * 1024 + 1, 0x61),
            1,
          ),
          "actual-overflow.zip",
        ),
      /invalid archive|scan budget/i,
    );
  });

  it("rejects a central entry assigned to another disk", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          centralEntryOnAnotherDisk(),
          "multi-disk-entry.zip",
        ),
      /invalid archive|unsupported archive/i,
    );
  });

  it("rejects concatenated raw deflate streams inside one compressed range", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          concatenatedDeflateZip(),
          "concatenated-deflate.zip",
        ),
      /invalid archive|unsupported archive/i,
    );
  });

  it("rejects an archive whose actual content CRC32 differs from both headers", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          deflatedZipWithWrongChecksum(
            "wrong-checksum.bin",
            Buffer.from("neutral runtime payload"),
          ),
          "wrong-checksum.zip",
        ),
      /invalid archive/i,
    );
  });

  it("rejects a readable deflate ZIP container with a nonzero local-header offset", () => {
    const privateKey = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nprefixed-secret\n-----END PRIVATE KEY-----",
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedReadableZip(privateKey),
          "prefixed-vision-release.bin",
        ),
      /invalid archive|private-key material/i,
    );
  });

  it("rejects a prefixed ZIP whose offsets remain relative to the archive start", () => {
    const privateKey = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nunadjusted-prefix-secret\n-----END PRIVATE KEY-----",
    );
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedZipWithUnadjustedOffsets(privateKey),
          "unadjusted-prefixed-vision-release.bin",
        ),
      /invalid archive|private-key material/i,
    );
  });

  it("rejects a prefixed multidisk-shaped ZIP before trusting disk fields", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedMultiDiskZip(
            Buffer.from("neutral prefixed multidisk payload"),
          ),
          "prefixed-multidisk.zip",
        ),
      /invalid archive/i,
    );
  });

  it("rejects a prefixed ZIP64-shaped archive before trusting sentinel fields", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedZip64Sentinel(Buffer.from("neutral prefixed ZIP64 payload")),
          "prefixed-zip64.zip",
        ),
      /invalid archive/i,
    );
  });

  it("rejects a prefixed ZIP-shaped archive with an orphan local record", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedZipWithOrphanLocal(Buffer.from("neutral orphan payload")),
          "prefixed-orphan.zip",
        ),
      /invalid archive/i,
    );
  });

  it("rejects a prefixed ZIP-shaped archive with corrupt finite central size", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          prefixedZipWithCorruptFiniteCentralSize(
            Buffer.from("neutral finite metadata payload"),
          ),
          "prefixed-central-size.zip",
        ),
      /invalid archive/i,
    );
  });

  it("rejects recognizable ZIP trailing structures without flagging incidental PK bytes", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          Buffer.concat([
            storedZip("runtime.txt", Buffer.from("safe")),
            Buffer.from("trailing-polyglot"),
          ]),
          "trailing-polyglot.bin",
        ),
      /invalid archive/i,
    );
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(
        Buffer.from("ordinary PK\u0003\u0004 noise PK\u0005\u0006 bytes"),
        "ordinary-runtime.bin",
      ),
    );
    const allowedExtra = Buffer.from([0xfe, 0xca, 0x02, 0x00, 0x12, 0x34]);
    assert.doesNotThrow(() =>
      assertNoPlatformPrivateKeyMaterial(
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
        "commented-runtime.zip",
      ),
    );
  });

  it("fails closed for oversized Vision and machine runtime artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-oversized-runtime-"));
    const artifact = join(root, "oversized-runtime.bin");
    try {
      const handle = await open(artifact, "w");
      try {
        await handle.truncate(256 * 1024 * 1024 + 1);
      } finally {
        await handle.close();
      }
      for (const role of ["vision-release", "vem-machine-ui"]) {
        await assert.rejects(
          () => assertNoPlatformPrivateKeyMaterialFile(artifact, role),
          /input limit/i,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a Base64 candidate exceeds the recursion depth", () => {
    assert.throws(
      () =>
        assertNoPlatformPrivateKeyMaterial(
          nestedBase64Payload(4),
          "nested-runtime-config",
        ),
      /bounded private-key scan budget/i,
    );
  });

  it("applies the scanner to every resolved Factory payload including Vision", async () => {
    const source = await readFile(
      "scripts/factory/build-factory-media.mjs",
      "utf8",
    );
    const boundary = source.slice(
      source.indexOf(
        "async function assertRuntimeAssetsContainNoPlatformPaymentSecrets",
      ),
      source.indexOf("async function collectImportedModuleInputs"),
    );
    assert.match(boundary, /for \(const asset of resolvedAssets\)/);
    assert.match(
      boundary,
      /if \(asset\.reference\.role === "windows-source-iso"\) \{[\s\S]*stageUncachedVerified[\s\S]*continue;/,
    );
    assert.match(
      boundary,
      /stageVerified[\s\S]*assertNoPlatformPrivateKeyMaterialFile/,
    );
    assert.match(boundary, /assertNoPlatformPrivateKeyMaterialFile/);
    assert.doesNotMatch(boundary, /vem-daemon.*vem-machine-ui/s);
  });
});
