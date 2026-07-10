import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MaintenanceSshCaSigner } from "./maintenance-ssh-ca-signer";

const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const REQUIRED = process.env.VEM_RUN_OPENSSH_INTEGRATION === "1";
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

describe("Maintenance SSH certificate against real Linux sshd", () => {
  it.runIf(REQUIRED)(
    "accepts only the configured CA, principal, source address, and current validity",
    async () => {
      const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
      const image = `vem-maintenance-openssh-integration:${suffix}`;
      const network = `vem-maintenance-openssh-${suffix}`;
      const server = `vem-maintenance-sshd-${suffix}`;
      const allowedClient = `vem-maintenance-ssh-allowed-${suffix}`;
      const wrongSourceClient = `vem-maintenance-ssh-wrong-source-${suffix}`;
      const directory = mkdtempSync(join(tmpdir(), "vem-openssh-integration-"));
      const subnetOctet = 20 + (process.pid % 180);
      const subnet = `10.250.${subnetOctet}.0/24`;
      const allowedSource = `10.250.${subnetOctet}.10`;
      const wrongSource = `10.250.${subnetOctet}.11`;
      const serverAddress = `10.250.${subnetOctet}.20`;
      let caSigner: MaintenanceSshCaSigner | undefined;
      let productionSigner: MaintenanceSshCaSigner | undefined;
      let wrongCaSigner: MaintenanceSshCaSigner | undefined;

      try {
        const caPath = generateKey(directory, "trusted-ca");
        const wrongCaPath = generateKey(directory, "wrong-ca");
        const userPath = generateKey(directory, "ephemeral-user");
        chmodSync(caPath, 0o400);
        chmodSync(wrongCaPath, 0o400);
        const trustedFingerprint = fingerprint(`${caPath}.pub`);
        caSigner = new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: trustedFingerprint,
          profile: "testbed",
        });
        productionSigner = new MaintenanceSshCaSigner({
          caPrivateKeyPath: caPath,
          expectedCaFingerprint: trustedFingerprint,
          profile: "production",
        });
        wrongCaSigner = new MaintenanceSshCaSigner({
          caPrivateKeyPath: wrongCaPath,
          expectedCaFingerprint: fingerprint(`${wrongCaPath}.pub`),
          profile: "testbed",
        });
        const publicKey = readFileSync(`${userPath}.pub`, "utf8")
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(" ");
        const now = Date.now();
        const request = {
          publicKey,
          sourceAddress: allowedSource,
          validAfter: new Date(now - 30_000),
          validBefore: new Date(now + 5 * 60_000),
          usage: "automation" as const,
        };
        const certificates = {
          correct: await caSigner.issue({
            ...request,
            serial: 101,
            keyId: "issue06:correct",
          }),
          wrongPrincipal: await productionSigner.issue({
            ...request,
            serial: 102,
            keyId: "issue06:wrong-principal",
          }),
          wrongCa: await wrongCaSigner.issue({
            ...request,
            serial: 103,
            keyId: "issue06:wrong-ca",
          }),
          expired: await caSigner.issue({
            ...request,
            serial: 104,
            keyId: "issue06:expired",
            validAfter: new Date(now - 2 * 60_000),
            validBefore: new Date(now - 60_000),
          }),
        };
        for (const [name, issued] of Object.entries(certificates)) {
          writeFileSync(
            join(directory, `${name}-cert.pub`),
            issued.certificate,
            {
              mode: 0o600,
            },
          );
        }
        const sshdConfigPath = join(directory, "sshd_config");
        const principalsPath = join(directory, "YKDZ");
        writeFileSync(
          sshdConfigPath,
          [
            "Port 2222",
            "ListenAddress 0.0.0.0",
            "HostKey /etc/ssh/ssh_host_ed25519_key",
            "PidFile /run/sshd/vem-test.pid",
            "TrustedUserCAKeys /etc/ssh/vem-maintenance-ca.pub",
            "AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u",
            "AuthorizedKeysFile none",
            "PubkeyAuthentication yes",
            "AuthenticationMethods publickey",
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "ChallengeResponseAuthentication no",
            "PermitEmptyPasswords no",
            "PermitRootLogin no",
            "UsePAM no",
            "AllowUsers YKDZ",
            "LogLevel VERBOSE",
          ].join("\n"),
        );
        writeFileSync(principalsPath, "YKDZ\n");

        run("docker", [
          "build",
          "--file",
          join(repositoryRoot, "apps/service-api/test/openssh/Dockerfile"),
          "--tag",
          image,
          repositoryRoot,
        ]);
        run("docker", ["network", "create", "--subnet", subnet, network]);
        startContainer(server, serverAddress);
        startContainer(allowedClient, allowedSource);
        startContainer(wrongSourceClient, wrongSource);
        dockerCopy(`${caPath}.pub`, server, "/etc/ssh/vem-maintenance-ca.pub");
        dockerCopy(sshdConfigPath, server, "/etc/ssh/sshd_config.vem");
        dockerCopy(principalsPath, server, "/etc/ssh/auth_principals/YKDZ");
        for (const client of [allowedClient, wrongSourceClient]) {
          dockerCopy(userPath, client, "/tmp/id_ed25519");
          for (const name of Object.keys(certificates)) {
            dockerCopy(
              join(directory, `${name}-cert.pub`),
              client,
              `/tmp/${name}-cert.pub`,
            );
          }
          run("docker", ["exec", client, "chmod", "600", "/tmp/id_ed25519"]);
        }
        run("docker", [
          "exec",
          server,
          "/usr/sbin/sshd",
          "-t",
          "-f",
          "/etc/ssh/sshd_config.vem",
        ]);
        run("docker", [
          "exec",
          "-d",
          server,
          "/usr/sbin/sshd",
          "-D",
          "-e",
          "-f",
          "/etc/ssh/sshd_config.vem",
        ]);

        const accepted = await waitForSsh(
          allowedClient,
          "/tmp/correct-cert.pub",
          serverAddress,
        );
        expect(accepted.status).toBe(0);
        expect(accepted.stdout).toBe("issue06-openssh-ok");
        for (const [client, certificate] of [
          [allowedClient, "/tmp/wrongPrincipal-cert.pub"],
          [allowedClient, "/tmp/wrongCa-cert.pub"],
          [allowedClient, "/tmp/expired-cert.pub"],
          [wrongSourceClient, "/tmp/correct-cert.pub"],
        ]) {
          expect(ssh(client, certificate, serverAddress).status).not.toBe(0);
        }
      } finally {
        caSigner?.close();
        productionSigner?.close();
        wrongCaSigner?.close();
        spawnSync(
          "docker",
          ["rm", "--force", server, allowedClient, wrongSourceClient],
          { stdio: "ignore" },
        );
        spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
        spawnSync("docker", ["image", "rm", "--force", image], {
          stdio: "ignore",
        });
        rmSync(directory, { recursive: true, force: true });
      }

      function startContainer(name: string, address: string): void {
        run("docker", [
          "run",
          "--detach",
          "--name",
          name,
          "--network",
          network,
          "--ip",
          address,
          image,
        ]);
      }
    },
    120_000,
  );
});

function generateKey(directory: string, name: string): string {
  const path = join(directory, name);
  execFileSync(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", path]);
  return path;
}

function fingerprint(path: string): string {
  const output = execFileSync(SSH_KEYGEN, ["-lf", path, "-E", "sha256"], {
    encoding: "utf8",
  });
  const value = output.match(/(SHA256:[A-Za-z0-9+/]+={0,2})/)?.[1];
  if (!value) throw new Error(`Could not read SSH fingerprint: ${path}`);
  return value;
}

function dockerCopy(source: string, container: string, target: string): void {
  run("docker", ["cp", source, `${container}:${target}`]);
}

function ssh(client: string, certificate: string, serverAddress: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      client,
      "ssh",
      "-p",
      "2222",
      "-o",
      "IdentityFile=/tmp/id_ed25519",
      "-o",
      `CertificateFile=${certificate}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `YKDZ@${serverAddress}`,
      "/usr/bin/printf issue06-openssh-ok",
    ],
    { encoding: "utf8" },
  );
}

async function waitForSsh(
  client: string,
  certificate: string,
  serverAddress: string,
) {
  return await attemptSsh(client, certificate, serverAddress, 30);
}

async function attemptSsh(
  client: string,
  certificate: string,
  serverAddress: string,
  attemptsRemaining: number,
) {
  const result = ssh(client, certificate, serverAddress);
  if (result.status === 0 || attemptsRemaining <= 0) return result;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  return await attemptSsh(
    client,
    certificate,
    serverAddress,
    attemptsRemaining - 1,
  );
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  }
}
