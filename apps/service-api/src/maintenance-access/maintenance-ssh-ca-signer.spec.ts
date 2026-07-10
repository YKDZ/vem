import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MaintenanceSshCaSigner } from "./maintenance-ssh-ca-signer";

const SSH_KEYGEN = "/usr/bin/ssh-keygen";

function fingerprint(path: string): string {
  return (
    execFileSync(SSH_KEYGEN, ["-lf", path, "-E", "sha256"], {
      encoding: "utf8",
    }).match(/(SHA256:[A-Za-z0-9+/]+=?)/)?.[1] ?? ""
  );
}

describe("MaintenanceSshCaSigner", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("issues a YKDZ certificate with an exact source /32 and removes signer files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    const userPath = join(directory, "ephemeral-user");
    const signerRoot = join(directory, "signer-tmp");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", userPath]);
    chmodSync(caPath, 0o400);

    const signer = new MaintenanceSshCaSigner({
      caPrivateKeyPath: caPath,
      expectedCaFingerprint: fingerprint(`${caPath}.pub`),
      profile: "testbed",
      temporaryRoot: signerRoot,
    });
    const validAfter = new Date("2026-07-10T12:00:00.000Z");
    const validBefore = new Date("2026-07-10T12:30:00.000Z");
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    const issued = await signer
      .issue({
        publicKey: readFileSync(`${userPath}.pub`, "utf8")
          .trim()
          .split(" ")
          .slice(0, 2)
          .join(" "),
        serial: 42,
        keyId: "vem-maintenance:session-1:request-1",
        sourceAddress: "10.91.1.10",
        validAfter,
        validBefore,
        usage: "human",
      })
      .finally(() => {
        if (previousTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimeZone;
      });

    const certificatePath = join(directory, "issued-cert.pub");
    writeFileSync(certificatePath, `${issued.certificate}\n`, { mode: 0o600 });
    const inspection = execFileSync(SSH_KEYGEN, ["-L", "-f", certificatePath], {
      encoding: "utf8",
    });
    expect(inspection).toContain(
      "Type: ssh-ed25519-cert-v01@openssh.com user certificate",
    );
    expect(inspection).toContain("Public key: ED25519-CERT");
    expect(inspection).toContain("Signing CA: ED25519");
    expect(inspection).toContain(
      'Key ID: "vem-maintenance:session-1:request-1"',
    );
    expect(inspection).toContain("Serial: 42");
    expect(inspection).toContain(
      "Valid: from 2026-07-10T12:00:00 to 2026-07-10T12:30:00",
    );
    expect(inspection).toContain("YKDZ");
    expect(inspection).toContain("source-address 10.91.1.10/32");
    expect(inspection).toContain("Extensions: (none)");
    expect(inspection).not.toContain("permit-agent-forwarding");
    expect(inspection).not.toContain("permit-port-forwarding");
    expect(inspection).not.toContain("permit-user-rc");
    expect(inspection).not.toContain("permit-X11-forwarding");
    expect(issued.certificate).toMatch(
      /^ssh-ed25519-cert-v01@openssh\.com [A-Za-z0-9+/]+={0,2}$/,
    );
    expect(issued.certificate.split(/\s+/)).toHaveLength(2);
    expect(issued.principal).toBe("YKDZ");
    expect(issued.validAfter).toEqual(validAfter);
    expect(issued.validBefore).toEqual(validBefore);
    expect(issued.caFingerprint).toBe(fingerprint(`${caPath}.pub`));
    expect(readdirSync(signerRoot)).toEqual([]);
  });

  it("fails closed when the mounted CA does not match the configured fingerprint", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    chmodSync(caPath, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint:
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          profile: "production",
        }),
    ).toThrow(
      "Maintenance SSH CA fingerprint does not match configured expectation",
    );
  });

  it("rejects a mode-0400 CA on a writable mount when read-only mounting is required", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    chmodSync(caPath, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: fingerprint(`${caPath}.pub`),
          profile: "testbed",
          requireReadOnlyMount: true,
        }),
    ).toThrow("Maintenance SSH CA private key mount must be read-only");
  });

  it("accepts a mode-0400 CA when the longest matching mount is read-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    const mountInfoPath = join(directory, "mountinfo");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    chmodSync(caPath, 0o400);
    writeFileSync(
      mountInfoPath,
      `1 0 0:1 / / rw,relatime - ext4 /dev/root rw\n2 1 0:2 / ${directory} ro,relatime - tmpfs tmpfs ro\n`,
    );

    const signer = new MaintenanceSshCaSigner({
      caPrivateKeyPath: caPath,
      expectedCaFingerprint: fingerprint(`${caPath}.pub`),
      profile: "testbed",
      requireReadOnlyMount: true,
      mountInfoPath,
    });
    signer.close();
  });

  it("fails closed when read-only mount state cannot be verified", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    chmodSync(caPath, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: fingerprint(`${caPath}.pub`),
          profile: "production",
          requireReadOnlyMount: true,
          mountInfoPath: join(directory, "missing-mountinfo"),
        }),
    ).toThrow(
      "Maintenance SSH CA private key mount read-only state could not be verified",
    );
  });

  it("rejects symlink and owner-writable CA paths during startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    const symlinkPath = join(directory, "maintenance-ca-link");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    symlinkSync(caPath, symlinkPath);

    for (const rejectedPath of [caPath, symlinkPath]) {
      expect(
        () =>
          new MaintenanceSshCaSigner({
            caPrivateKeyPath: rejectedPath,
            expectedCaFingerprint: fingerprint(`${caPath}.pub`),
            profile: "testbed",
          }),
      ).toThrow(
        "Maintenance SSH CA private key must be a read-only regular file",
      );
    }
  });

  it("keeps signing with the startup-opened CA after its configured path is replaced", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    const replacementPath = join(directory, "replacement-ca");
    const userPath = join(directory, "ephemeral-user");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    execFileSync(SSH_KEYGEN, [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      replacementPath,
    ]);
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", userPath]);
    chmodSync(caPath, 0o400);
    chmodSync(replacementPath, 0o400);
    const expectedFingerprint = fingerprint(`${caPath}.pub`);
    const signer = new MaintenanceSshCaSigner({
      caPrivateKeyPath: caPath,
      expectedCaFingerprint: expectedFingerprint,
      profile: "testbed",
    });
    renameSync(replacementPath, caPath);

    const issued = await signer.issue({
      publicKey: readFileSync(`${userPath}.pub`, "utf8")
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" "),
      serial: 44,
      keyId: "vem-maintenance:session-1:stable-fd",
      sourceAddress: "10.91.1.12",
      validAfter: new Date("2026-07-10T12:00:00.000Z"),
      validBefore: new Date("2026-07-10T12:30:00.000Z"),
      usage: "automation",
    });
    signer.close();

    expect(issued.caFingerprint).toBe(expectedFingerprint);
  });

  it("rejects a non-Ed25519 CA during startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, [
      "-q",
      "-t",
      "rsa",
      "-b",
      "2048",
      "-N",
      "",
      "-f",
      caPath,
    ]);
    chmodSync(caPath, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: fingerprint(`${caPath}.pub`),
          profile: "testbed",
        }),
    ).toThrow("Maintenance SSH CA must be an unencrypted Ed25519 private key");
  });

  it("rejects an Ed25519 public key file during startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    chmodSync(`${caPath}.pub`, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: `${caPath}.pub`,
          expectedCaFingerprint: fingerprint(`${caPath}.pub`),
          profile: "testbed",
        }),
    ).toThrow("Maintenance SSH CA must be an unencrypted Ed25519 private key");
  });

  it("rejects an encrypted Ed25519 private key during startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    execFileSync(SSH_KEYGEN, [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "not-a-runtime-passphrase",
      "-f",
      caPath,
    ]);
    chmodSync(caPath, 0o400);

    expect(
      () =>
        new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: fingerprint(`${caPath}.pub`),
          profile: "testbed",
        }),
    ).toThrow("Maintenance SSH CA must be an unencrypted Ed25519 private key");
  });

  it("returns the parsed second-precision validity and no automation extensions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-ssh-ca-"));
    directories.push(directory);
    const caPath = join(directory, "maintenance-ca");
    const userPath = join(directory, "ephemeral-user");
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", caPath]);
    execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", userPath]);
    chmodSync(caPath, 0o400);

    const issued = await new MaintenanceSshCaSigner({
      caPrivateKeyPath: caPath,
      expectedCaFingerprint: fingerprint(`${caPath}.pub`),
      profile: "testbed",
    }).issue({
      publicKey: readFileSync(`${userPath}.pub`, "utf8")
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" "),
      serial: 43,
      keyId: "vem-maintenance:session-1:automation-request",
      sourceAddress: "10.91.1.11",
      validAfter: new Date("2026-07-10T12:00:00.987Z"),
      validBefore: new Date("2026-07-10T12:30:00.999Z"),
      usage: "automation",
    });

    const certificatePath = join(directory, "automation-cert.pub");
    writeFileSync(certificatePath, `${issued.certificate}\n`, { mode: 0o600 });
    const inspection = execFileSync(SSH_KEYGEN, ["-L", "-f", certificatePath], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });
    expect(inspection).toContain("source-address 10.91.1.11/32");
    expect(inspection).toContain("Extensions: (none)");
    expect(issued.validAfter).toEqual(new Date("2026-07-10T12:00:00.000Z"));
    expect(issued.validBefore).toEqual(new Date("2026-07-10T12:30:00.000Z"));
  });
});
