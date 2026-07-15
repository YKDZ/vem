import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertNoPlatformPrivateKeyMaterial } from "../security/platform-private-key-scanner.mjs";

function storedZip(
  name,
  content,
  declaredUncompressedSize = content.length,
  flags = 0,
) {
  const fileName = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(declaredUncompressedSize, 22);
  header.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(declaredUncompressedSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = header.length + fileName.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([header, fileName, content, central, fileName, end]);
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
    assert.match(boundary, /assertNoPlatformPrivateKeyMaterialFile/);
    assert.doesNotMatch(boundary, /vem-daemon.*vem-machine-ui/s);
  });
});
