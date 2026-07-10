import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceApiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(serviceApiRoot, "../..");
const image = `vem-service-api-maintenance-ssh-ca-test:${process.pid}`;
const scratchRoot = resolve(repositoryRoot, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const directory = mkdtempSync(join(scratchRoot, "ssh-ca-container-"));
const caPath = join(directory, "maintenance-ca");

try {
  execFileSync("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    caPath,
  ]);
  chmodSync(caPath, 0o400);
  const fingerprint = execFileSync(
    "/usr/bin/ssh-keygen",
    ["-lf", `${caPath}.pub`, "-E", "sha256"],
    { encoding: "utf8" },
  ).match(/(SHA256:[A-Za-z0-9+/]+={0,2})/)?.[1];
  if (!fingerprint) throw new Error("Could not read test CA fingerprint");

  run("docker", [
    "build",
    "--target",
    "maintenance-ssh-ca-test",
    "--file",
    join(repositoryRoot, "apps/service-api/Dockerfile"),
    "--tag",
    image,
    repositoryRoot,
  ]);

  const hostCaPath = dockerHostPath(caPath);
  run("docker", [
    "run",
    "--rm",
    "--user",
    "0:0",
    "--mount",
    `type=bind,source=${hostCaPath},target=/fixture-ca`,
    "--entrypoint",
    "chown",
    image,
    "1000:1000",
    "/fixture-ca",
  ]);
  run("docker", containerArgs(hostCaPath, true, fingerprint));

  const writable = spawnSync(
    "docker",
    containerArgs(hostCaPath, false, fingerprint),
    { encoding: "utf8" },
  );
  if (
    writable.status === 0 ||
    !`${writable.stdout}${writable.stderr}`.includes(
      "Maintenance SSH CA private key mount must be read-only",
    )
  ) {
    throw new Error(
      `Writable CA bind did not fail closed:\n${writable.stdout}${writable.stderr}`,
    );
  }
} finally {
  spawnSync("docker", ["image", "rm", "--force", image], {
    stdio: "ignore",
  });
  rmSync(directory, { recursive: true, force: true });
}

function containerArgs(hostCaPath, readOnly, fingerprint) {
  return [
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m",
    "--mount",
    `type=bind,source=${hostCaPath},target=/run/secrets/maintenance_ssh_ca${readOnly ? ",readonly" : ""}`,
    image,
    "/run/secrets/maintenance_ssh_ca",
    fingerprint,
  ];
}

function dockerHostPath(localPath) {
  try {
    const mounts = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .Mounts}}", hostname()],
        { encoding: "utf8" },
      ),
    );
    const mount = mounts
      .filter(({ Type }) => Type === "bind")
      .filter(
        ({ Destination }) =>
          localPath === Destination || localPath.startsWith(`${Destination}/`),
      )
      .sort(
        (left, right) => right.Destination.length - left.Destination.length,
      )[0];
    if (mount)
      return join(mount.Source, relative(mount.Destination, localPath));
  } catch {
    // Outside a container the Docker daemon normally sees the same path.
  }
  if (localPath.startsWith(tmpdir())) return localPath;
  return localPath;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
