#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG =
  "scripts/testbed/vm-host-adapters/libvirt-qcow2.unraid.json";
const RESTORE_REPORT_SCHEMA_VERSION = "vm-host-restore-report/v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizeRunId(runId) {
  const normalized = String(runId ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (normalized.length === 0) {
    throw new Error("--run-id must contain letters or numbers");
  }
  if (normalized.length > 32) {
    throw new Error("--run-id must normalize to at most 32 characters");
  }
  return normalized;
}

function requireString(value, label) {
  const text = String(value ?? "").trim();
  if (text.length === 0) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertSafeAbsolutePath(path, label) {
  const text = requireString(path, label);
  if (!text.startsWith("/")) {
    throw new Error(`${label} must be an absolute host path`);
  }
  if (text.includes("\0") || text.includes("..")) {
    throw new Error(`${label} must not contain unsafe path segments`);
  }
  return text;
}

function loadAdapterConfig(path = DEFAULT_CONFIG) {
  const config = readJson(path);
  if (config?.adapter !== "libvirt-qcow2") {
    throw new Error("adapter config must declare libvirt-qcow2");
  }
  if (
    !Array.isArray(config.allowedTargets) ||
    config.allowedTargets.length === 0
  ) {
    throw new Error("adapter config must include allowedTargets");
  }
  return config;
}

function findAllowedTarget(config, options) {
  const targetVm = requireString(options.targetVm, "--target-vm");
  const baseImage = assertSafeAbsolutePath(options.baseImage, "--base-image");
  const overlayDisk = assertSafeAbsolutePath(
    options.overlayDisk,
    "--overlay-disk",
  );
  const windowsSshUser = requireString(
    options.windowsSshUser,
    "--windows-ssh-user",
  );
  const windowsSshHost = requireString(
    options.windowsSshHost,
    "--windows-ssh-host",
  );

  const target = config.allowedTargets.find(
    (candidate) => candidate.name === targetVm,
  );
  if (!target) {
    throw new Error(`target VM is not allowlisted: ${targetVm}`);
  }
  if (target.overlayDisk !== overlayDisk) {
    throw new Error(
      `overlay disk is not allowlisted for ${targetVm}: ${overlayDisk}`,
    );
  }
  if (
    !Array.isArray(target.baseImages) ||
    !target.baseImages.includes(baseImage)
  ) {
    throw new Error(
      `base image is not allowlisted for ${targetVm}: ${baseImage}`,
    );
  }
  if (target.windowsSshUser !== windowsSshUser) {
    throw new Error(
      `Windows SSH user is not allowlisted for ${targetVm}: ${windowsSshUser}`,
    );
  }
  if (
    Array.isArray(target.windowsSshHosts) &&
    target.windowsSshHosts.length > 0 &&
    !target.windowsSshHosts.includes(windowsSshHost)
  ) {
    throw new Error(
      `Windows SSH host is not allowlisted for ${targetVm}: ${windowsSshHost}`,
    );
  }
  if (
    options.maintenanceRelayInterface ||
    options.maintenanceRelayRunnerPeerIp
  ) {
    const relay = target.preconfiguredMaintenanceRelay;
    if (relay?.bootstrapMode !== "preconfigured-base-image") {
      throw new Error(
        "Maintenance Relay restore requires target.preconfiguredMaintenanceRelay.bootstrapMode=preconfigured-base-image; the adapter does not configure the VM WireGuard peer or Windows Controlled Maintenance Ingress during restore",
      );
    }
    if (relay.kind !== "wireguard-maintenance-relay") {
      throw new Error(
        "Maintenance Relay restore requires target.preconfiguredMaintenanceRelay.kind=wireguard-maintenance-relay",
      );
    }
    if (relay.vmWireGuardPeer !== "preconfigured-and-running") {
      throw new Error(
        "Maintenance Relay restore requires a base image with the VM WireGuard peer preconfigured and running",
      );
    }
    if (
      relay.windowsControlledMaintenanceIngress !==
      "preconfigured-source-allowlist"
    ) {
      throw new Error(
        "Maintenance Relay restore requires Windows Controlled Maintenance Ingress preconfigured with the runner peer allowlist",
      );
    }
    if (relay.windowsSshHost !== windowsSshHost) {
      throw new Error(
        `Maintenance Relay Windows SSH host is not allowlisted by the preconfigured VM relay contract: ${windowsSshHost}`,
      );
    }
    const allowedSourcePeerIps = Array.isArray(relay.allowedSourcePeerIps)
      ? relay.allowedSourcePeerIps
      : [];
    if (!allowedSourcePeerIps.includes(options.maintenanceRelayRunnerPeerIp)) {
      throw new Error(
        `Maintenance Relay runner peer IP is not allowlisted by the preconfigured VM relay contract: ${options.maintenanceRelayRunnerPeerIp}`,
      );
    }
  }
  return target;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    if (options.allowFailure === true) {
      return result.stdout ?? "";
    }
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.stderr || result.stdout || `exit ${result.status}`
      }`,
    );
  }
  return result.stdout ?? "";
}

function fileSha256(path, runner = runCommand) {
  const output = runner("sha256sum", [path]).trim();
  const hash = output.split(/\s+/)[0];
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`sha256sum returned invalid hash for ${path}: ${output}`);
  }
  return hash;
}

function waitForWindowsSsh({
  host,
  user,
  identity,
  certificate,
  timeoutSeconds = 600,
  runner = runCommand,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = "";
  const sshArgs = [
    "-o",
    `IdentityFile=${requireString(identity, "--identity")}`,
    "-o",
    `CertificateFile=${requireString(certificate, "--certificate")}`,
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
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${user}@${host}`,
    "hostname",
  ];
  while (Date.now() <= deadline) {
    try {
      runner("ssh", sshArgs);
      return { reachable: true };
    } catch (error) {
      lastError = error.message;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`Windows SSH did not become reachable: ${lastError}`);
}

function buildRestoreReport(input) {
  const controlledMaintenanceIngress =
    input.controlledMaintenanceIngress ||
    (input.maintenanceRelayInterface || input.maintenanceRelayRunnerPeerIp
      ? {
          kind: "wireguard-maintenance-relay",
          windowsSshHost: input.windowsSshHost ?? input.windowsSsh?.host,
          allowedSourcePeerIp: input.maintenanceRelayRunnerPeerIp,
          interface: input.maintenanceRelayInterface,
          bootstrapMode: "preconfigured-base-image",
          preconfiguredVmRelayContract: {
            vmWireGuardPeer: "preconfigured-and-running",
            windowsControlledMaintenanceIngress:
              "preconfigured-source-allowlist",
            repositoryConfiguresVmRelay: false,
          },
        }
      : undefined);
  const restoreReportMaintenanceIngress = controlledMaintenanceIngress
    ? {
        ...controlledMaintenanceIngress,
        preflight:
          input.dryRun === true
            ? {
                status: "not_asserted",
                assertion:
                  "base_image_preconfigures_vm_wireguard_peer_and_ingress",
                failureMode:
                  "restore SSH readiness fails clearly; adapter does not bootstrap VM-side relay",
              }
            : {
                status: "passed",
                assertion: "ssh_reachable_over_preconfigured_vm_wireguard_ip",
                failureCodeIfUnreachable:
                  "vm_relay_preconfiguration_missing_or_windows_ingress_blocked",
              },
      }
    : undefined;
  return {
    schemaVersion: RESTORE_REPORT_SCHEMA_VERSION,
    adapter: "libvirt-qcow2",
    runId: input.runId,
    targetVm: {
      name: input.targetVm,
    },
    baseImage: {
      path: input.baseImage,
      sha256: input.baseImageSha256,
    },
    restoredDisk: {
      path: input.overlayDisk,
      backingFile: input.baseImage,
    },
    windowsSsh: {
      host: input.windowsSshHost ?? input.windowsSsh?.host,
      user: input.windowsSshUser ?? input.windowsSsh?.user,
    },
    evidence: {
      reportPath: input.out,
      dryRun: input.dryRun === true,
    },
    ...(restoreReportMaintenanceIngress
      ? { controlledMaintenanceIngress: restoreReportMaintenanceIngress }
      : {}),
    result: "passed",
  };
}

export function buildLibvirtQcow2RestorePlan(options = {}) {
  const runId = normalizeRunId(options.runId);
  const config = loadAdapterConfig(options.config ?? DEFAULT_CONFIG);
  const target = findAllowedTarget(config, options);
  return {
    schemaVersion: "vm-host-restore-plan/v1",
    adapter: "libvirt-qcow2",
    runId,
    targetVm: requireString(options.targetVm, "--target-vm"),
    baseImage: assertSafeAbsolutePath(options.baseImage, "--base-image"),
    overlayDisk: assertSafeAbsolutePath(options.overlayDisk, "--overlay-disk"),
    tempOverlayDisk: `${assertSafeAbsolutePath(options.overlayDisk, "--overlay-disk")}.tmp-${runId}`,
    windowsSsh: {
      host: requireString(options.windowsSshHost, "--windows-ssh-host"),
      user: requireString(options.windowsSshUser, "--windows-ssh-user"),
      identity: requireString(options.identity, "--identity"),
      certificate: requireString(options.certificate, "--certificate"),
      timeoutSeconds: Number(options.windowsSshTimeoutSeconds ?? 600),
    },
    controlledMaintenanceIngress:
      options.maintenanceRelayInterface || options.maintenanceRelayRunnerPeerIp
        ? {
            kind: "wireguard-maintenance-relay",
            bootstrapMode: "preconfigured-base-image",
            windowsSshHost: requireString(
              options.windowsSshHost,
              "--windows-ssh-host",
            ),
            allowedSourcePeerIp: requireString(
              options.maintenanceRelayRunnerPeerIp,
              "--maintenance-relay-runner-peer-ip",
            ),
            interface: requireString(
              options.maintenanceRelayInterface,
              "--maintenance-relay-interface",
            ),
            preconfiguredVmRelayContract: {
              vmWireGuardPeer:
                target.preconfiguredMaintenanceRelay.vmWireGuardPeer,
              windowsControlledMaintenanceIngress:
                target.preconfiguredMaintenanceRelay
                  .windowsControlledMaintenanceIngress,
              repositoryConfiguresVmRelay: false,
            },
            preflight: {
              status: "required_before_restore_wait",
              assertion:
                "base_image_preconfigures_vm_wireguard_peer_and_ingress",
              failureMode:
                "restore SSH readiness fails clearly; adapter does not bootstrap VM-side relay",
            },
          }
        : undefined,
    configPath: options.config ?? DEFAULT_CONFIG,
  };
}

export function restoreLibvirtQcow2Vm(options = {}, dependencies = {}) {
  const plan = buildLibvirtQcow2RestorePlan(options);
  const runner = dependencies.runner ?? runCommand;
  const sha256 = dependencies.sha256 ?? ((path) => fileSha256(path, runner));
  const waitForSsh = dependencies.waitForSsh ?? waitForWindowsSsh;
  const dryRun = options.dryRun === true;

  const suppliedBaseImageSha256 =
    options.baseImageSha256 && SHA256_PATTERN.test(options.baseImageSha256)
      ? options.baseImageSha256
      : null;

  if (
    !existsSync(plan.baseImage) &&
    dependencies.skipFileExistenceCheck !== true &&
    !(dryRun && suppliedBaseImageSha256)
  ) {
    throw new Error(`base image does not exist: ${plan.baseImage}`);
  }

  const baseImageSha256 = suppliedBaseImageSha256 ?? sha256(plan.baseImage);

  if (dryRun) {
    return buildRestoreReport({
      ...plan,
      baseImageSha256,
      out: options.out ?? null,
      dryRun,
    });
  }

  if (options.allowRestore !== true) {
    throw new Error("live VM restore requires --allow-restore");
  }

  runner("virsh", ["destroy", plan.targetVm], { allowFailure: true });
  rmSync(plan.tempOverlayDisk, { force: true });
  runner("qemu-img", [
    "create",
    "-f",
    "qcow2",
    "-F",
    "qcow2",
    "-b",
    plan.baseImage,
    plan.tempOverlayDisk,
  ]);
  rmSync(plan.overlayDisk, { force: true });
  renameSync(plan.tempOverlayDisk, plan.overlayDisk);
  runner("virsh", ["start", plan.targetVm]);
  waitForSsh({
    host: plan.windowsSsh.host,
    user: plan.windowsSsh.user,
    identity: plan.windowsSsh.identity,
    certificate: plan.windowsSsh.certificate,
    timeoutSeconds: plan.windowsSsh.timeoutSeconds,
    runner,
  });

  return buildRestoreReport({
    ...plan,
    baseImageSha256,
    out: options.out ?? null,
    dryRun,
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  console.error(`Usage:
  vm-host-adapter.mjs --mode restore --adapter libvirt-qcow2 --run-id RUN-ID --target-vm VM --base-image PATH --overlay-disk PATH --windows-ssh-host HOST --windows-ssh-user USER --identity PRIVATE_KEY --certificate CERTIFICATE --out REPORT [--config PATH] [--base-image-sha256 SHA256] [--allow-restore] [--dry-run]
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--mode") {
      options.mode = next;
      index += 1;
    } else if (arg === "--adapter") {
      options.adapter = next;
      index += 1;
    } else if (arg === "--config") {
      options.config = next;
      index += 1;
    } else if (arg === "--run-id") {
      options.runId = next;
      index += 1;
    } else if (arg === "--target-vm") {
      options.targetVm = next;
      index += 1;
    } else if (arg === "--base-image") {
      options.baseImage = next;
      index += 1;
    } else if (arg === "--base-image-sha256") {
      options.baseImageSha256 = next;
      index += 1;
    } else if (arg === "--overlay-disk") {
      options.overlayDisk = next;
      index += 1;
    } else if (arg === "--windows-ssh-host") {
      options.windowsSshHost = next;
      index += 1;
    } else if (arg === "--windows-ssh-user") {
      options.windowsSshUser = next;
      index += 1;
    } else if (arg === "--identity") {
      options.identity = next;
      index += 1;
    } else if (arg === "--certificate") {
      options.certificate = next;
      index += 1;
    } else if (arg === "--windows-ssh-timeout-seconds") {
      options.windowsSshTimeoutSeconds = next;
      index += 1;
    } else if (arg === "--maintenance-relay-interface") {
      options.maintenanceRelayInterface = next;
      index += 1;
    } else if (arg === "--maintenance-relay-runner-peer-ip") {
      options.maintenanceRelayRunnerPeerIp = next;
      index += 1;
    } else if (arg === "--out") {
      options.out = next;
      index += 1;
    } else if (arg === "--allow-restore") {
      options.allowRestore = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    if (options.mode !== "restore" || options.adapter !== "libvirt-qcow2") {
      throw new Error(
        "only --mode restore --adapter libvirt-qcow2 is supported",
      );
    }
    const report = restoreLibvirtQcow2Vm(options);
    if (options.out) {
      writeJson(options.out, report);
      console.error(`wrote report: ${options.out}`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
