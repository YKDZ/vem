import { maintenanceSshUserPublicKeySchema } from "@vem/shared";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SSH_KEYGEN = "/usr/bin/ssh-keygen";

type MaintenanceSshProfile = "testbed" | "production";

const PRINCIPAL_BY_PROFILE: Record<MaintenanceSshProfile, string> = {
  testbed: "YKDZ",
  production: "Admin",
};

export type MaintenanceSshCaSignerOptions = {
  caPrivateKeyPath: string;
  expectedCaFingerprint: string;
  profile: MaintenanceSshProfile;
  temporaryRoot?: string;
  requireReadOnlyMount?: boolean;
  mountInfoPath?: string;
};

export type MaintenanceSshCertificateSigningRequest = {
  publicKey: string;
  serial: number;
  keyId: string;
  sourceAddress: string;
  validAfter: Date;
  validBefore: Date;
  usage: "human" | "automation";
};

export type IssuedMaintenanceSshCertificate = {
  certificate: string;
  caFingerprint: string;
  principal: string;
  validAfter: Date;
  validBefore: Date;
};

export class MaintenanceSshCaSigner {
  private caFileDescriptor = -1;
  private readonly caFingerprint: string;
  private readonly principal: string;
  private readonly temporaryRoot: string;

  constructor(private readonly options: MaintenanceSshCaSignerOptions) {
    this.principal = PRINCIPAL_BY_PROFILE[options.profile];
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.caFileDescriptor = this.openValidatedCa();
    try {
      this.assertEd25519PrivateKey();
      this.caFingerprint = this.readCaFingerprint();
      if (this.caFingerprint !== options.expectedCaFingerprint) {
        throw new Error(
          "Maintenance SSH CA fingerprint does not match configured expectation",
        );
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async issue(
    request: MaintenanceSshCertificateSigningRequest,
  ): Promise<IssuedMaintenanceSshCertificate> {
    if (this.caFileDescriptor < 0) {
      throw new Error("Maintenance SSH CA signer is closed");
    }
    if (!Number.isSafeInteger(request.serial) || request.serial < 1) {
      throw new Error("Maintenance SSH certificate serial must be positive");
    }
    if (request.validBefore <= request.validAfter) {
      throw new Error("Maintenance SSH certificate validity is invalid");
    }
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(request.sourceAddress)) {
      throw new Error("Maintenance SSH certificate source address is invalid");
    }
    const publicKey = maintenanceSshUserPublicKeySchema.safeParse(
      request.publicKey,
    );
    if (!publicKey.success) {
      throw new Error("Maintenance SSH certificate public key is invalid");
    }

    mkdirSync(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(
      join(this.temporaryRoot, "vem-maintenance-ssh-"),
    );
    try {
      const subjectPath = join(directory, "subject.pub");
      writeFileSync(subjectPath, `${publicKey.data}\n`, { mode: 0o600 });
      const sourceAddress = `${request.sourceAddress}/32`;
      await runSshKeygenWithCa(
        [
          "-q",
          "-s",
          "/proc/self/fd/3",
          "-I",
          request.keyId,
          "-n",
          this.principal,
          "-V",
          `${formatOpenSshTime(request.validAfter)}:${formatOpenSshTime(request.validBefore)}`,
          "-O",
          "clear",
          "-O",
          `source-address=${sourceAddress}`,
          "-z",
          String(request.serial),
          subjectPath,
        ],
        this.caFileDescriptor,
      );
      const certificateParts = readFileSync(
        join(directory, "subject-cert.pub"),
        "utf8",
      )
        .trim()
        .split(/\s+/);
      if (
        certificateParts[0] !== "ssh-ed25519-cert-v01@openssh.com" ||
        !certificateParts[1]
      ) {
        throw new Error(
          "Maintenance SSH signer returned an unexpected certificate",
        );
      }
      const certificate = certificateParts.slice(0, 2).join(" ");
      const inspection = await inspectCertificate(
        join(directory, "subject-cert.pub"),
      );
      const expectedValidAfter = truncateToSeconds(request.validAfter);
      const expectedValidBefore = truncateToSeconds(request.validBefore);
      if (
        inspection.caFingerprint !== this.caFingerprint ||
        inspection.serial !== request.serial ||
        inspection.keyId !== request.keyId ||
        inspection.validAfter.getTime() !== expectedValidAfter.getTime() ||
        inspection.validBefore.getTime() !== expectedValidBefore.getTime() ||
        inspection.principals.length !== 1 ||
        inspection.principals[0] !== this.principal ||
        inspection.criticalOptions.length !== 1 ||
        inspection.criticalOptions[0] !==
          `source-address ${request.sourceAddress}/32` ||
        inspection.extensions.length !== 0
      ) {
        throw new Error(
          "Maintenance SSH signer returned an unexpected certificate",
        );
      }
      return {
        certificate,
        caFingerprint: this.caFingerprint,
        principal: this.principal,
        validAfter: inspection.validAfter,
        validBefore: inspection.validBefore,
      };
    } catch {
      throw new Error("Maintenance SSH certificate signing failed");
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
    }
  }

  close(): void {
    if (this.caFileDescriptor >= 0) {
      closeSync(this.caFileDescriptor);
      this.caFileDescriptor = -1;
    }
  }

  private openValidatedCa(): number {
    const absolutePath = resolve(this.options.caPrivateKeyPath);
    const pathMetadata = lstatSync(absolutePath);
    if (!pathMetadata.isFile() || realpathSync(absolutePath) !== absolutePath) {
      throw new Error(
        "Maintenance SSH CA private key must be a read-only regular file",
      );
    }
    const descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.mode & 0o222) {
        throw new Error(
          "Maintenance SSH CA private key must be a read-only regular file",
        );
      }
      if (
        this.options.requireReadOnlyMount &&
        !isPathOnReadOnlyMount(
          absolutePath,
          this.options.mountInfoPath ?? "/proc/self/mountinfo",
        )
      ) {
        throw new Error(
          "Maintenance SSH CA private key mount must be read-only",
        );
      }
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private readCaFingerprint(): string {
    try {
      const output = this.runCaSshKeygenSync([
        "-lf",
        "/proc/self/fd/3",
        "-E",
        "sha256",
      ]);
      const fingerprint = /\b(SHA256:[A-Za-z0-9+/]+={0,2})\b/.exec(output)?.[1];
      if (!fingerprint) throw new Error("missing fingerprint");
      return fingerprint;
    } catch {
      throw new Error("Maintenance SSH CA fingerprint could not be read");
    }
  }

  private assertEd25519PrivateKey(): void {
    try {
      const publicKey = this.runCaSshKeygenSync(["-y", "-f", "/proc/self/fd/3"])
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");
      if (!maintenanceSshUserPublicKeySchema.safeParse(publicKey).success) {
        throw new Error("unexpected CA public key type");
      }
    } catch {
      throw new Error(
        "Maintenance SSH CA must be an unencrypted Ed25519 private key",
      );
    }
  }

  private runCaSshKeygenSync(args: string[]): string {
    return execFileSync(SSH_KEYGEN, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: "never",
      },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe", this.caFileDescriptor],
    });
  }
}

function isPathOnReadOnlyMount(path: string, mountInfoPath: string): boolean {
  let mountInfo: string;
  try {
    mountInfo = readFileSync(mountInfoPath, "utf8");
  } catch {
    throw new Error(
      "Maintenance SSH CA private key mount read-only state could not be verified",
    );
  }
  const matches = mountInfo
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields.length >= 6)
    .map((fields) => ({
      mountPoint: decodeMountInfoPath(fields[4] ?? ""),
      options: (fields[5] ?? "").split(","),
    }))
    .filter(
      ({ mountPoint }) =>
        mountPoint === "/" ||
        path === mountPoint ||
        path.startsWith(`${mountPoint}${sep}`),
    )
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  const mount = matches[0];
  if (!mount) {
    throw new Error(
      "Maintenance SSH CA private key mount read-only state could not be verified",
    );
  }
  return mount.options.includes("ro");
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function runSshKeygenWithCa(
  args: string[],
  caFileDescriptor: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(SSH_KEYGEN, args, {
      env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
      stdio: ["ignore", "ignore", "pipe", caFileDescriptor],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024) child.kill();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("ssh-keygen failed"));
    });
  });
}

type OpenSshCertificateInspection = {
  caFingerprint: string;
  serial: number;
  keyId: string;
  validAfter: Date;
  validBefore: Date;
  principals: string[];
  criticalOptions: string[];
  extensions: string[];
};

async function inspectCertificate(
  path: string,
): Promise<OpenSshCertificateInspection> {
  const { stdout } = await execFileAsync(SSH_KEYGEN, ["-L", "-f", path], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    windowsHide: true,
    maxBuffer: 16 * 1024,
  });
  const lines = stdout.split("\n");
  const field = (name: string): string | undefined =>
    lines
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  const signingCa = field("Signing CA");
  const caFingerprint = /\b(SHA256:[A-Za-z0-9+/]+={0,2})\b/.exec(
    signingCa ?? "",
  )?.[1];
  const serial = Number(field("Serial"));
  const keyIdMatch = /^"(.*)"$/.exec(field("Key ID") ?? "");
  const validity =
    /^from (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}) to (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/.exec(
      field("Valid") ?? "",
    );
  if (
    !stdout.includes(
      "Type: ssh-ed25519-cert-v01@openssh.com user certificate",
    ) ||
    !caFingerprint ||
    !Number.isSafeInteger(serial) ||
    !keyIdMatch ||
    !validity
  ) {
    throw new Error("Maintenance SSH certificate inspection failed");
  }
  return {
    caFingerprint,
    serial,
    keyId: keyIdMatch[1] ?? "",
    validAfter: new Date(`${validity[1]}Z`),
    validBefore: new Date(`${validity[2]}Z`),
    principals: inspectionSection(lines, "Principals"),
    criticalOptions: inspectionSection(lines, "Critical Options"),
    extensions: inspectionSection(lines, "Extensions"),
  };
}

function inspectionSection(lines: string[], name: string): string[] {
  const index = lines.findIndex((line) => {
    const normalized = line.trim();
    return normalized === `${name}:` || normalized === `${name}: (none)`;
  });
  if (index < 0) throw new Error(`Maintenance SSH ${name} section is missing`);
  if (lines[index]?.trim() === `${name}: (none)`) return [];
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.startsWith("                ")) break;
    values.push(line.trim());
  }
  return values;
}

function formatOpenSshTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

function truncateToSeconds(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}
