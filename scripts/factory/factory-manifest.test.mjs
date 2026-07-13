import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FactoryManifestError,
  createFactoryManifest,
  validateFactoryManifest,
} from "./factory-manifest.mjs";

const HASH = "a".repeat(64);

function asset(role, version = "1.0.0") {
  const value = {
    role,
    mediaFileName: `${role}.bin`,
    identity: `factory-cas://sha256/${HASH}`,
    digest: `sha256:${HASH}`,
    version,
    signature: {
      scheme: "detached-ed25519",
      signerIdentity: `spki-sha256:${HASH}`,
      evidenceIdentity: `factory-evidence://sha256/${HASH}`,
      evidenceDigest: `sha256:${HASH}`,
    },
    provenance: {
      predicateType: "https://slsa.dev/provenance/v1",
      sourceIdentity: `source:${role}`,
      builderIdentity: "builder:vem-fixture",
      buildId: "fixture-build-1",
      signerIdentity: `spki-sha256:${HASH}`,
      evidenceIdentity: `factory-evidence://sha256/${HASH}`,
      evidenceDigest: `sha256:${HASH}`,
    },
  };
  if (role === "vision-release") {
    value.release = {
      descriptorIdentity: `factory-evidence://sha256/${HASH}`,
      descriptorDigest: `sha256:${HASH}`,
      attestationIdentity: `factory-evidence://sha256/${HASH}`,
      attestationDigest: `sha256:${HASH}`,
      approvalIdentity: `factory-evidence://sha256/${HASH}`,
      approvalDigest: `sha256:${HASH}`,
      conformanceEvidenceIdentity: `factory-evidence://sha256/${HASH}`,
      conformanceEvidenceDigest: `sha256:${HASH}`,
    };
  }
  return value;
}

function validInput() {
  return {
    schemaVersion: "vem-factory-manifest/v1",
    kind: "factory-manifest",
    profile: "testbed",
    source: {
      windowsMedia: asset("windows-source-iso", "10.0.19045"),
      installImageIndex: 1,
      installImageEdition: "Professional",
      installImageDigest: `sha256:${HASH}`,
      targetFirmware: "uefi",
    },
    factoryPreparation: {
      schemaVersion: "vem-factory-preparation/v1",
      kind: "factory-preparation",
      environmentName: "factory-testbed",
      provisioningEndpoint: "http://platform.invalid/api",
      mqttUrl: "mqtt://platform.invalid:1883",
      hardware: {
        mode: "simulated",
        model: "fixture",
        topologyIdentity: "topology:fixture",
        topologyVersion: "1",
      },
      display: { width: 1080, height: 1920, orientation: "portrait" },
      accounts: {
        kioskUser: "VEMKiosk",
        maintenanceUser: "YKDZ",
        autoLogonUser: "VEMKiosk",
      },
      expectedKioskShell: "C:\\VEM\\bringup\\machine.exe",
      targetLayoutVersion: "vem-runtime/v1",
      maintenance: {
        wireGuardInterfaceAlias: "VEM-Maintenance",
        wireGuardListenAddress: "10.0.0.2/32",
        runnerSourceAllowlist: ["10.77.20.2/32"],
        maintainerSourceAllowlist: ["fd00:77:20::3/128"],
        openSsh: {
          version: "9.8.1",
          approvedSignerThumbprint: "A".repeat(40),
          approvedRootThumbprint: "B".repeat(40),
        },
        wireGuard: {
          version: "0.5.3",
          approvedSignerThumbprint: "C".repeat(40),
          approvedRootThumbprint: "D".repeat(40),
        },
      },
    },
    assets: [
      asset("openssh-installer", "9.8.1"),
      asset("wireguard-installer", "0.5.3"),
      asset("vem-daemon", "0.1.0"),
      asset("vem-machine-ui", "0.1.0"),
      asset("webview2-loader", "1.0.0"),
      asset("vision-release", "2026.7.11"),
      asset("vision-configuration", "1.0.0"),
      asset("maintenance-ssh-ca-public-key", "1.0.0"),
    ],
    toolchain: {
      builderImage: {
        identity: "oci://ghcr.io/vem/factory-builder@sha256:" + HASH,
        digest: `sha256:${HASH}`,
        version: "1.0.0",
      },
      udfExtractor: {
        identity: "tool://7z@sha256:" + HASH,
        digest: `sha256:${HASH}`,
        version: "26.1.0",
      },
      udfWriter: {
        identity: "tool://genisoimage@sha256:" + HASH,
        digest: `sha256:${HASH}`,
        version: "1.1.11",
      },
      wimlib: {
        identity: "tool://wimlib-imagex@sha256:" + HASH,
        digest: `sha256:${HASH}`,
        version: "1.14.4",
      },
    },
    outputPolicy: {
      isoFileName: "vem-factory-{manifestId}.iso",
      reproducible: true,
      includeProvenance: true,
      assemblyMode: "windows-serviced-iso",
    },
  };
}

describe("Factory Manifest v1", () => {
  it("creates and validates an immutable profile-neutral manifest", () => {
    const manifest = createFactoryManifest(validInput());

    assert.match(manifest.manifestId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      validateFactoryManifest(manifest).manifestId,
      manifest.manifestId,
    );
  });

  it("rejects an asset without immutable identity, digest, version, signature, or provenance", () => {
    const manifest = createFactoryManifest(validInput());
    delete manifest.assets[0].identity;

    assert.throws(
      () => validateFactoryManifest(manifest),
      (error) =>
        error instanceof FactoryManifestError &&
        error.issues.some((issue) => issue.path === "assets[0].identity"),
    );
  });

  it("requires matched Vision release evidence before a Factory Manifest can select it", () => {
    const missing = validInput();
    delete missing.assets.find((asset) => asset.role === "vision-release")
      .release;
    assert.throws(
      () => createFactoryManifest(missing),
      /Vision release.*required|release/i,
    );

    const mismatched = validInput();
    mismatched.assets.find(
      (asset) => asset.role === "vision-release",
    ).release.approvalDigest = `sha256:${"b".repeat(64)}`;
    assert.throws(
      () => createFactoryManifest(mismatched),
      /approval.*match|identity/i,
    );
  });

  it("rejects duplicate roles, mutable references, profile contamination, and secrets", () => {
    const duplicate = createFactoryManifest(validInput());
    duplicate.assets[1].role = duplicate.assets[0].role;
    assert.throws(
      () => validateFactoryManifest(duplicate),
      /duplicate asset role/,
    );

    const mutable = createFactoryManifest(validInput());
    mutable.assets[0].identity = "https://example.invalid/openssh.msi";
    assert.throws(
      () => validateFactoryManifest(mutable),
      /content-addressed|mutable/,
    );

    const contaminated = createFactoryManifest(validInput());
    contaminated.profile = "production";
    contaminated.assets[0].provenance.sourceIdentity = "source:testbed-fixture";
    assert.throws(() => validateFactoryManifest(contaminated), /testbed/);

    const secret = createFactoryManifest(validInput());
    secret.privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----";
    assert.throws(
      () => validateFactoryManifest(secret),
      /unknown field|private key/,
    );
  });

  it("matches the published role, count, strict SemVer, and unknown-field contract", () => {
    const wrongSourceRole = validInput();
    wrongSourceRole.source.windowsMedia.role = "vem-daemon";
    assert.throws(
      () => createFactoryManifest(wrongSourceRole),
      /source\.windowsMedia\.role/,
    );

    const extraAsset = validInput();
    extraAsset.assets.push(asset("vem-daemon"));
    assert.throws(() => createFactoryManifest(extraAsset), /assets|duplicate/);

    for (const invalidVersion of ["1", "01.2.3", "1.2", "1.2.3.4", "v1.2.3"]) {
      const invalid = validInput();
      invalid.assets[0].version = invalidVersion;
      assert.throws(
        () => createFactoryManifest(invalid),
        /version.*semantic version|semver/i,
      );
    }

    const nestedUnknown = validInput();
    nestedUnknown.assets[0].signature.comment = "not in schema";
    assert.throws(
      () => createFactoryManifest(nestedUnknown),
      /unknown field|additional properties/i,
    );
  });

  it("binds every tool URI digest to its digest field", () => {
    const input = validInput();
    input.toolchain.udfWriter.digest = `sha256:${"b".repeat(64)}`;
    assert.throws(
      () => createFactoryManifest(input),
      /udfWriter.*digest|digest.*identity/i,
    );
  });

  it("requires a pinned AuthentiCode verifier and binds embedded evidence to the asset", () => {
    const input = validInput();
    input.assets[0].signature = {
      scheme: "authenticode",
      signerIdentity: `x509-sha256:${HASH}`,
      evidenceIdentity: input.assets[0].identity,
      evidenceDigest: input.assets[0].digest,
    };
    assert.throws(() => createFactoryManifest(input), /authenticodeVerifier/i);
    input.toolchain.authenticodeVerifier = {
      identity: `tool://osslsigncode@sha256:${HASH}`,
      digest: `sha256:${HASH}`,
      version: "2.5.0",
    };
    assert.doesNotThrow(() => createFactoryManifest(input));
    input.assets[0].signature.evidenceDigest = `sha256:${"b".repeat(64)}`;
    assert.throws(
      () => createFactoryManifest(input),
      /signed asset bytes|evidence/i,
    );
  });

  it("rejects file URIs, absolute paths, encoded paths, and secret-like values", () => {
    const attacks = [
      "file:///var/lib/vem/source.iso",
      "/var/lib/vem/source.iso",
      "C:\\factory\\source.iso",
      "%2Fvar%2Flib%2Fvem%2Fsource.iso",
      "password%3Dhunter2",
      "Bearer abcdefghijklmnopqrstuvwxyz012345",
    ];
    for (const attack of attacks) {
      const input = validInput();
      input.assets[0].provenance.buildId = attack;
      assert.throws(
        () => createFactoryManifest(input),
        /host path|file URI|secret|network source|not permitted/i,
        attack,
      );
    }
  });

  it("rejects fixture assembly, Windows reserved names, and case-colliding media names", () => {
    const fixture = validInput();
    fixture.outputPolicy.assemblyMode = "bootable-fixture-envelope";
    assert.throws(() => createFactoryManifest(fixture), /windows-serviced-iso/);
    const reserved = validInput();
    reserved.assets[0].mediaFileName = "CON.msi";
    assert.throws(
      () => createFactoryManifest(reserved),
      /Windows-safe|reserved/i,
    );
    const collision = validInput();
    collision.assets[0].mediaFileName = "Runtime.MSI";
    collision.assets[1].mediaFileName = "runtime.msi";
    assert.throws(
      () => createFactoryManifest(collision),
      /case-insensitively/i,
    );
  });

  it("requires a supported firmware target, pinned WIM inspector, and complete nonsecret preparation descriptor", () => {
    const firmware = validInput();
    firmware.source.targetFirmware = "bios";
    assert.equal(createFactoryManifest(firmware).source.targetFirmware, "bios");
    firmware.source.targetFirmware = "legacy";
    assert.throws(
      () => createFactoryManifest(firmware),
      /targetFirmware|bios|uefi/,
    );
    const edition = validInput();
    edition.source.installImageEdition = "Enterprise";
    assert.throws(
      () => createFactoryManifest(edition),
      /installImageEdition|Professional/,
    );
    const missingWimlib = validInput();
    delete missingWimlib.toolchain.wimlib;
    assert.throws(() => createFactoryManifest(missingWimlib), /wimlib/i);
    const incomplete = validInput();
    incomplete.factoryPreparation.maintenance.runnerSourceAllowlist = [];
    assert.throws(
      () => createFactoryManifest(incomplete),
      /runnerSourceAllowlist/,
    );
    const broadIngress = validInput();
    broadIngress.factoryPreparation.maintenance.runnerSourceAllowlist = [
      "10.77.20.0/24",
    ];
    assert.throws(
      () => createFactoryManifest(broadIngress),
      /runnerSourceAllowlist|exact IPv4/,
    );
  });
});
