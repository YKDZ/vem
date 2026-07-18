#!/usr/bin/env node

import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { renderLibvirtDomainXml } from "./libvirt-runtime-profile.mjs";
import {
  REQUIRED_COMMANDS,
  assertFileSha256,
  assertReadableRegularFile,
  baselinePublicationLayout,
  evaluateHostPreflight,
  parseGuestAddress,
  publishVerifiedBaselineRelease,
  readJsonWithBom,
  recoverPublishedBaseline,
  runtimeProfileForConfig,
  runtimeProfileForPublishedRelease,
  validateBaselineBuildConfig,
} from "./linux-kvm-baseline.mjs";

const execFile = promisify(execFileCallback);
const BASELINE_ROOT = new URL(".", import.meta.url);
export const SPICE_GUEST_TOOLS_INSTALLER_FILE = "spice-guest-tools-0.141.exe";
export const RUNNER_ARCHIVE_FILE = "actions-runner-win-x64.zip";
const INTERACTIVE_DISPLAY_REPORT_PATH =
  "C:\\ProgramData\\WindowsRuntimeBaseline\\interactive-display-report.json";
const GUEST_AVAILABILITY_TIMEOUT_MS = 60 * 60 * 1000;
const INTERACTIVE_DISPLAY_STAGE_TIMEOUT_MS = 20 * 60 * 1000;
const INTERACTIVE_DISPLAY_POLL_INTERVAL_MS = 10 * 1000;
const INTERACTIVE_DISPLAY_INITIAL_REARM_DELAY_MS = 60 * 1000;
const INTERACTIVE_DISPLAY_MAX_REARM_ATTEMPTS = 2;
const PREPARE_VM_RUNTIME_SCRIPT =
  "C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1";

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") {
      options.execute = true;
      continue;
    }
    if (!value.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${value}`);
    }
    options[value.slice(2)] = argv[++index];
  }
  if (!options.config) throw new Error("--config is required");
  if (
    options["source-commit"] !== undefined &&
    !/^[0-9a-f]{7,64}$/i.test(options["source-commit"])
  ) {
    throw new Error("--source-commit must be a Git commit SHA");
  }
  return options;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(command, args, { allowFailure = false } = {}) {
  return execFile(command, args, { maxBuffer: 1024 * 1024 }).catch((error) => {
    if (allowFailure)
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        failed: true,
      };
    throw new Error(`${command} failed: ${error.stderr || error.message}`);
  });
}

async function existingParent(path) {
  let candidate = path;
  while (true) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate)
        throw new Error(`no existing parent for ${path}`);
      candidate = parent;
    }
  }
}

async function availableStorageBytes(path) {
  const filesystem = await statfs(await existingParent(path));
  return Number(filesystem.bavail) * Number(filesystem.bsize);
}

async function readable(path) {
  try {
    await assertReadableRegularFile(path, path);
    return true;
  } catch {
    return false;
  }
}

async function kvmDeviceAvailable() {
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
    return (await stat("/dev/kvm")).isCharacterDevice();
  } catch {
    return false;
  }
}

async function collectExecutingHostIdentity(configuredAddress) {
  const hostnames = new Set([hostname().toLowerCase()]);
  const fqdn = await run("hostname", ["-f"], { allowFailure: true });
  if (!fqdn.failed && fqdn.stdout.trim())
    hostnames.add(fqdn.stdout.trim().toLowerCase());
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address) addresses.add(entry.address.toLowerCase());
    }
  }
  const resolvedConfiguredAddresses = new Set(
    (
      await lookup(configuredAddress, { all: true, verbatim: true }).catch(
        () => [],
      )
    ).map((entry) => entry.address.toLowerCase()),
  );
  return {
    hostnames: [...hostnames],
    addresses: [...addresses],
    resolvedConfiguredAddresses: [...resolvedConfiguredAddresses],
  };
}

function commandExists(command) {
  return (
    spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" })
      .status === 0
  );
}

async function collectHostObservation(config) {
  const profile = runtimeProfileForConfig(config);
  const commands = REQUIRED_COMMANDS.filter(commandExists);
  const network = await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "net-info", config.vm.networkName],
    { allowFailure: true },
  );
  const libvirt = await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "uri"],
    {
      allowFailure: true,
    },
  );
  const memory = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const availableMemoryKiB = Number(
    /^MemAvailable:\s+(\d+)/m.exec(memory)?.[1] ?? 0,
  );
  return {
    hostIdentity: await collectExecutingHostIdentity(config.host.address),
    kvmAvailable: await kvmDeviceAvailable(),
    libvirtAvailable: !libvirt.failed,
    commands,
    cpuCount: availableParallelism(),
    availableMemoryMiB: Math.floor(availableMemoryKiB / 1024),
    storageAvailableBytes: {
      baseline: await availableStorageBytes(config.storage.baselinePath),
      cache: await availableStorageBytes(config.storage.cacheDiskPath),
    },
    installationMedia: {
      windowsIso: await readable(config.media.windowsIsoPath),
      spiceGuestToolsInstaller: await readable(
        config.media.spiceGuestToolsInstallerPath,
      ),
      runnerArchive: await assertFileSha256(
        config.media.runnerArchivePath,
        config.media.runnerArchiveSha256,
        "media.runnerArchivePath",
      )
        .then(() => true)
        .catch(() => false),
    },
    networkActive: !network.failed && /^Active:\s+yes$/im.test(network.stdout),
    profile,
  };
}

export function renderUnattendedXml(config) {
  const password = escapeXml(config.__secrets.administratorPassword);
  const user = escapeXml(config.guest.sshUser);
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      <InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Active>true</Active><Format>NTFS</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition></ModifyPartitions></Disk></DiskConfiguration>
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${config.media.windowsImageIndex}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>2</PartitionID></InstallTo></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><FullName>Runtime Baseline</FullName><Organization>Runtime Baseline</Organization><ProductKey><Key>W269N-WFGWX-YVC9B-4J6C9-T83GX</Key><WillShowUI>Never</WillShowUI></ProductKey></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd.exe /d /c "for %d in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do @if exist %d:\\baseline-config.json xcopy %d:\\* C:\\ProgramData\\WindowsRuntimeBaseline\\media\\ /E /I /Y"</Path><Description>Stage runtime baseline media</Description></RunSynchronousCommand></RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>${user}</Name><Group>Administrators</Group><Password><Value>${password}</Value><PlainText>true</PlainText></Password></LocalAccount></LocalAccounts></UserAccounts>
      <AutoLogon><Username>${user}</Username><Password><Value>${password}</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>2</LogonCount></AutoLogon>
      <FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -File &quot;C:\\ProgramData\\WindowsRuntimeBaseline\\media\\bootstrap.ps1&quot;</CommandLine><Description>Prepare runtime baseline</Description></SynchronousCommand></FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

export function bootstrapScript() {
  return `$ErrorActionPreference = "Stop"
$mediaRoot = $PSScriptRoot
$config = Get-Content -Raw (Join-Path $mediaRoot "baseline-config.json") | ConvertFrom-Json
${"$scriptRoot"} = "C:\\ProgramData\\WindowsRuntimeBaseline\\scripts"
New-Item -ItemType Directory -Force -Path ${"$scriptRoot"} | Out-Null
Copy-Item -Force (Join-Path $mediaRoot "*.ps1") ${"$scriptRoot"}
& (Join-Path $mediaRoot "shared-guest-preparation.ps1") -WebView2InstallerUri $config.webView2InstallerUri -AuthorizedKeysPath (Join-Path $mediaRoot "administrators_authorized_keys")
& (Join-Path $mediaRoot "prepare-vm-runtime.ps1") -Mode PrepareKvmGuest -SpiceGuestToolsInstallerPath (Join-Path $mediaRoot $config.spiceGuestToolsInstallerFile) -InteractiveUser $config.interactiveUser -DesktopWidth $config.display.width -DesktopHeight $config.display.height -DesktopScalePercent $config.display.scalePercent
`;
}

export function guestConfigurationFor(config) {
  return {
    webView2InstallerUri: config.media.webView2InstallerUri,
    spiceGuestToolsInstallerFile: SPICE_GUEST_TOOLS_INSTALLER_FILE,
    runnerArchiveFile: RUNNER_ARCHIVE_FILE,
    interactiveUser: config.guest.sshUser,
    display: {
      width: 1080,
      height: 1920,
      scalePercent: config.guest.desktopScalePercent,
    },
  };
}

export async function createConfigurationMedia(
  config,
  stagingDirectory,
  { runCommand = run } = {},
) {
  const mediaRoot = join(stagingDirectory, "configuration-media");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  for (const name of [
    "shared-guest-preparation.ps1",
    "prepare-vm-runtime.ps1",
    "verify-vm-runtime.ps1",
  ]) {
    await copyFile(new URL(name, BASELINE_ROOT), join(mediaRoot, name));
  }
  const secrets = {
    administratorPassword: (
      await readFile(config.guest.administratorPasswordFile, "utf8")
    ).trim(),
  };
  if (!secrets.administratorPassword)
    throw new Error("administrator password file must not be empty");
  const protectedConfig = {
    ...config,
    __secrets: secrets,
  };
  const guestConfig = guestConfigurationFor(config);
  await writeFile(
    join(mediaRoot, "autounattend.xml"),
    renderUnattendedXml(protectedConfig),
    { mode: 0o600 },
  );
  await writeFile(join(mediaRoot, "bootstrap.ps1"), bootstrapScript(), {
    mode: 0o600,
  });
  await writeFile(
    join(mediaRoot, "baseline-config.json"),
    `${JSON.stringify(guestConfig)}\n`,
    { mode: 0o600 },
  );
  await copyFile(
    config.guest.authorizedKeysFile,
    join(mediaRoot, "administrators_authorized_keys"),
  );
  await copyFile(
    config.media.spiceGuestToolsInstallerPath,
    join(mediaRoot, SPICE_GUEST_TOOLS_INSTALLER_FILE),
  );
  await assertFileSha256(
    config.media.runnerArchivePath,
    config.media.runnerArchiveSha256,
    "media.runnerArchivePath",
  );
  await copyFile(
    config.media.runnerArchivePath,
    join(mediaRoot, RUNNER_ARCHIVE_FILE),
  );
  const isoPath = join(stagingDirectory, "baseline-configuration.iso");
  await runCommand("xorriso", [
    "-as",
    "mkisofs",
    "-iso-level",
    "3",
    "-J",
    "-r",
    "-o",
    isoPath,
    mediaRoot,
  ]);
  return isoPath;
}

async function discoverGuestAddress(config, domainName) {
  const command = [
    "--connect",
    config.host.libvirtUri,
    "domifaddr",
    domainName,
    "--source",
    "lease",
  ];
  const result = await run("virsh", command, { allowFailure: true });
  const fromDomainLease = result.failed
    ? null
    : parseGuestAddress(result.stdout, config.vm.macAddress);
  if (fromDomainLease) return fromDomainLease;
  const lease = await run(
    "virsh",
    [
      "--connect",
      config.host.libvirtUri,
      "net-dhcp-leases",
      config.vm.networkName,
    ],
    { allowFailure: true },
  );
  return lease.failed
    ? null
    : parseGuestAddress(lease.stdout, config.vm.macAddress);
}

function guestSshOptions(config, knownHostsPath) {
  return [
    "-i",
    config.guest.sshPrivateKeyFile,
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
}

function powershellScriptLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedPowerShellCommand(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function encodedPowerShellRequest(request) {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

function prepareVmRuntimeCommand(request) {
  const encodedRequest = encodedPowerShellRequest(request);
  const bindings = [
    "-Mode $request.Mode",
    "-InteractiveUser $request.InteractiveUser",
    "-DesktopWidth $request.DesktopWidth",
    "-DesktopHeight $request.DesktopHeight",
    "-DesktopScalePercent $request.DesktopScalePercent",
  ];
  if (request.SpiceGuestToolsInstallerPath !== undefined) {
    bindings.splice(
      2,
      0,
      "-SpiceGuestToolsInstallerPath $request.SpiceGuestToolsInstallerPath",
    );
  }
  return encodedPowerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedRequest}")) | ConvertFrom-Json`,
      `& "${PREPARE_VM_RUNTIME_SCRIPT}" ${bindings.join(" ")}`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("\r\n"),
  );
}

function interactiveDisplayStatusCommand(config) {
  return prepareVmRuntimeCommand({
    Mode: "GetInteractiveDisplayPreparationStatus",
    InteractiveUser: config.guest.sshUser,
    DesktopWidth: 1080,
    DesktopHeight: 1920,
    DesktopScalePercent: config.guest.desktopScalePercent,
  });
}

function rearmInteractiveDisplayCommand(config) {
  return prepareVmRuntimeCommand({
    Mode: "RearmInteractiveDisplay",
    InteractiveUser: config.guest.sshUser,
    SpiceGuestToolsInstallerPath: `C:\\ProgramData\\WindowsRuntimeBaseline\\media\\${SPICE_GUEST_TOOLS_INSTALLER_FILE}`,
    DesktopWidth: 1080,
    DesktopHeight: 1920,
    DesktopScalePercent: config.guest.desktopScalePercent,
  });
}

function verificationCommand({ config, runnerName, verificationPath }) {
  const encodedRequest = encodedPowerShellRequest({
    ExpectedWidth: 1080,
    ExpectedHeight: 1920,
    ExpectedScalePercent: config.guest.desktopScalePercent,
    ExpectedInteractiveUser: config.guest.sshUser,
    ExpectedRunnerUrl: config.runner.url,
    ExpectedRunnerName: runnerName,
    ExpectedAudioModel: "ich9",
    ExpectedSerialRole: ["lower-controller", "scanner"],
    ExpectedSerialUsbPort: [1, 2],
    OutputPath: verificationPath,
  });
  return encodedPowerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedRequest}")) | ConvertFrom-Json`,
      '$runner = Get-Content -Raw -LiteralPath "C:\\ProgramData\\WindowsRuntimeBaseline\\runner-registration.json" | ConvertFrom-Json',
      '& "C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\verify-vm-runtime.ps1" -ExpectedWidth $request.ExpectedWidth -ExpectedHeight $request.ExpectedHeight -ExpectedScalePercent $request.ExpectedScalePercent -ExpectedInteractiveUser $request.ExpectedInteractiveUser -ExpectedRunnerUrl $request.ExpectedRunnerUrl -ExpectedRunnerName $request.ExpectedRunnerName -ExpectedRunnerServiceName $runner.serviceName -ExpectedAudioModel $request.ExpectedAudioModel -ExpectedSerialRole @($request.ExpectedSerialRole) -ExpectedSerialUsbPort @($request.ExpectedSerialUsbPort) -OutputPath $request.OutputPath',
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("\r\n"),
  );
}

function validateInteractiveDisplayReport(report, config) {
  if (!report || typeof report !== "object") {
    throw new Error("interactive display report is not an object");
  }
  if (report.schemaVersion !== "win10-kvm-interactive-display/v1") {
    throw new Error("interactive display report schema is invalid");
  }
  const expectedUser = new RegExp(
    `\\\\${String(config.guest.sshUser).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
  );
  if (!expectedUser.test(String(report.interactiveUser ?? ""))) {
    throw new Error("interactive display report belongs to an unexpected user");
  }
  if (
    !Number.isInteger(report.interactiveSessionId) ||
    report.interactiveSessionId < 1
  ) {
    throw new Error(
      "interactive display report has an invalid session binding",
    );
  }
  if (
    report.desktop?.width !== 1080 ||
    report.desktop?.height !== 1920 ||
    report.desktop?.scalePercent !== config.guest.desktopScalePercent
  ) {
    throw new Error(
      "interactive display report does not match the requested desktop",
    );
  }
  if (!/QXL/i.test(String(report.qxlDisplayAdapter ?? ""))) {
    throw new Error(
      "interactive display report does not identify the QXL adapter",
    );
  }
  return report;
}

function formatInteractiveDisplayDiagnostics(diagnostic) {
  const status = diagnostic.status ?? {};
  const task = status.task ?? {};
  const state = status.state ?? {};
  const spice = status.spiceGuestToolsInstallation ?? {};
  const cleanup = status.cleanup ?? {};
  const parts = [
    `report=${status.reportPresent === true ? "present" : "absent"}`,
    `reportValid=${status.reportValid === true}`,
    `completionValid=${interactiveDisplayCompleted(status)}`,
    `phase=${state.phase ?? "unknown"}`,
    `task state=${task.state ?? "absent"}`,
    `lastTaskResult=${task.lastTaskResult ?? "unknown"}`,
    `taskRemoved=${cleanup.taskRemoved === true}`,
    `RunOnceRemoved=${cleanup.spiceGuestToolsResumeRemoved === true}`,
    `AutoAdminLogonDisabled=${cleanup.automaticLogonDisabled === true}`,
    `spice phase=${spice.phase ?? "unknown"}`,
  ];
  if (diagnostic.error) parts.push(`error=${diagnostic.error}`);
  if (diagnostic.awaitingReboot) {
    parts.push(
      `awaiting reboot from=${diagnostic.awaitingReboot.bootIdentity ?? "unknown"} sshDown=${diagnostic.awaitingReboot.sshWentDown === true}`,
    );
  }
  if (status.taskLogTail) parts.push(`task log=${status.taskLogTail}`);
  return parts.join(", ");
}

function interactiveDisplayCompleted(status) {
  return (
    status?.reportValid === true &&
    status.state?.phase === "complete" &&
    status.task === null &&
    status.cleanup?.taskRemoved === true &&
    status.cleanup?.spiceGuestToolsResumeRemoved === true &&
    status.cleanup?.automaticLogonDisabled === true
  );
}

function shouldRearmInteractiveDisplay(status, sshReadyAt, now, delayMs) {
  if (interactiveDisplayCompleted(status)) return false;
  if (status.reportValid === true) return true;
  if (status.state?.phase === "failed") return true;
  if (now - sshReadyAt < delayMs) return false;
  if (
    status.spiceGuestToolsInstallation?.phase === "installing" &&
    status.spiceGuestToolsInstallation.installBootIdentity ===
      status.currentBootIdentity
  ) {
    return false;
  }
  return !status.task || status.task.state !== "Running";
}

export async function waitForInteractiveDisplayReport(
  config,
  domainName,
  stagingDirectory,
  {
    displayStageTimeoutMs,
    discoverGuestAddress: findGuestAddress = discoverGuestAddress,
    guestAvailabilityTimeoutMs = GUEST_AVAILABILITY_TIMEOUT_MS,
    initialRearmDelayMs = INTERACTIVE_DISPLAY_INITIAL_REARM_DELAY_MS,
    maxRearmAttempts = INTERACTIVE_DISPLAY_MAX_REARM_ATTEMPTS,
    now = () => Date.now(),
    pollIntervalMs = INTERACTIVE_DISPLAY_POLL_INTERVAL_MS,
    runCommand = run,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs,
  } = {},
) {
  const localReport = join(stagingDirectory, "interactive-display-report.json");
  const knownHostsPath = join(stagingDirectory, "known_hosts");
  const availabilityStartedAt = now();
  const availabilityDeadline =
    availabilityStartedAt + guestAvailabilityTimeoutMs;
  const resolvedDisplayStageTimeoutMs =
    displayStageTimeoutMs ?? timeoutMs ?? INTERACTIVE_DISPLAY_STAGE_TIMEOUT_MS;
  let rearmAttempts = 0;
  let sshReadyAt = null;
  let displayStageStartedAt = null;
  let displayStageDeadline = null;
  let awaitingReboot = null;
  let diagnostic = { error: "SSH has not become available" };

  while (true) {
    const currentTime = now();
    if (currentTime >= availabilityDeadline) {
      throw new Error(
        `guest availability timed out after ${guestAvailabilityTimeoutMs} ms; ${formatInteractiveDisplayDiagnostics(diagnostic)}`,
      );
    }
    if (displayStageDeadline !== null && currentTime >= displayStageDeadline) {
      throw new Error(
        `interactive display preparation timed out: interactive display stage timed out after ${resolvedDisplayStageTimeoutMs} ms; first SSH readiness at ${displayStageStartedAt - availabilityStartedAt} ms; ${formatInteractiveDisplayDiagnostics(diagnostic)}`,
      );
    }
    const address = await findGuestAddress(config, domainName);
    if (!address) {
      diagnostic = {
        error: "guest has no discovered DHCP lease",
        awaitingReboot,
      };
      await sleep(pollIntervalMs);
      continue;
    }

    const target = `${config.guest.sshUser}@${address}`;
    const sshOptions = guestSshOptions(config, knownHostsPath);
    const ssh = await runCommand("ssh", [...sshOptions, target, "exit"], {
      allowFailure: true,
    });
    if (ssh.failed) {
      if (awaitingReboot) awaitingReboot.sshWentDown = true;
      diagnostic = {
        error: "guest SSH is unavailable",
        awaitingReboot,
      };
      await sleep(pollIntervalMs);
      continue;
    }
    if (sshReadyAt === null) sshReadyAt = now();
    if (displayStageStartedAt === null) {
      displayStageStartedAt = sshReadyAt;
      displayStageDeadline =
        displayStageStartedAt + resolvedDisplayStageTimeoutMs;
    }

    const statusResult = await runCommand(
      "ssh",
      [...sshOptions, target, interactiveDisplayStatusCommand(config)],
      { allowFailure: true },
    );
    if (statusResult.failed) {
      diagnostic = { error: "interactive display status command failed" };
      await sleep(pollIntervalMs);
      continue;
    }

    let status;
    try {
      status = readJsonWithBom(statusResult.stdout ?? "");
      if (!status || typeof status !== "object") {
        throw new Error("status output is not a JSON object");
      }
      diagnostic = { status, awaitingReboot };
    } catch (error) {
      diagnostic = {
        error: `invalid interactive display status: ${error.message}`,
        awaitingReboot,
      };
      await sleep(pollIntervalMs);
      continue;
    }

    if (awaitingReboot) {
      const bootIdentityChanged =
        typeof awaitingReboot.bootIdentity === "string" &&
        typeof status.currentBootIdentity === "string" &&
        awaitingReboot.bootIdentity !== status.currentBootIdentity;
      if (!awaitingReboot.sshWentDown && !bootIdentityChanged) {
        diagnostic = {
          status,
          awaitingReboot,
          error: "waiting for the requested reboot to become observable",
        };
        await sleep(pollIntervalMs);
        continue;
      }
      awaitingReboot = null;
      sshReadyAt = now();
    }

    if (interactiveDisplayCompleted(status)) {
      const reportCopy = await runCommand("scp", [
        ...sshOptions,
        `${target}:${INTERACTIVE_DISPLAY_REPORT_PATH.replaceAll("\\", "/")}`,
        localReport,
      ]);
      if (reportCopy.failed) {
        diagnostic = {
          status,
          error: "interactive display report copy failed",
        };
      } else {
        try {
          return {
            address,
            report: validateInteractiveDisplayReport(
              readJsonWithBom(await readFile(localReport, "utf8")),
              config,
            ),
            sshOptions,
            target,
          };
        } catch (error) {
          throw new Error(
            `interactive display report is invalid: ${error.message}`,
          );
        }
      }
    }

    if (
      rearmAttempts < maxRearmAttempts &&
      shouldRearmInteractiveDisplay(
        status,
        sshReadyAt,
        now(),
        initialRearmDelayMs,
      )
    ) {
      rearmAttempts += 1;
      const rearm = await runCommand(
        "ssh",
        [...sshOptions, target, rearmInteractiveDisplayCommand(config)],
        { allowFailure: true },
      );
      let rearmCompletion = null;
      if (!rearm.failed) {
        try {
          const response = readJsonWithBom(rearm.stdout ?? "");
          if (interactiveDisplayCompleted(response)) rearmCompletion = response;
        } catch {
          // A reboot can close the SSH channel before PowerShell flushes JSON.
        }
      }
      if (rearmCompletion) {
        diagnostic = { status: rearmCompletion };
      } else {
        awaitingReboot = {
          bootIdentity:
            typeof status.currentBootIdentity === "string"
              ? status.currentBootIdentity
              : null,
          sshWentDown: false,
        };
        sshReadyAt = null;
        diagnostic = rearm.failed
          ? {
              status,
              awaitingReboot,
              error: `interactive display re-arm ${rearmAttempts} did not complete over SSH`,
            }
          : { status, awaitingReboot };
      }
    }
    await sleep(pollIntervalMs);
  }
}

function xmlAttributeEquals(element, attribute, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${attribute}=(['\"])${escaped}\\1`).test(element);
}

// Libvirt owns the SPICE backend and pins each otherwise-identical QEMU USB
// serial device to a distinct controller port. The guest verifies those ports.
export function verifyDefinedRuntimeDevices(domainXml, profile) {
  const xml = String(domainXml);
  const audio = [...xml.matchAll(/<audio\b[^>]*\/?>(?:<\/audio>)?/g)];
  const sounds = [...xml.matchAll(/<sound\b[^>]*\/?>(?:<\/sound>)?/g)];
  if (
    audio.length !== 1 ||
    !xmlAttributeEquals(audio[0][0], "id", "1") ||
    !xmlAttributeEquals(audio[0][0], "type", profile.audio.backend)
  ) {
    throw new Error(
      "defined domain must contain exactly one SPICE audio backend",
    );
  }
  if (
    sounds.length !== 1 ||
    !xmlAttributeEquals(sounds[0][0], "model", profile.audio.model) ||
    /\baudio=(['"])/.test(sounds[0][0])
  ) {
    throw new Error("defined domain must use the default ICH9 audio device");
  }
  const serial = [...xml.matchAll(/<serial\b[^>]*>([\s\S]*?)<\/serial>/g)];
  if (serial.length !== profile.serialRoles.length) {
    throw new Error(
      "defined domain must contain exactly the configured USB serial roles",
    );
  }
  const serialRoles = serial.map((entry, index) => {
    const definition = entry[0];
    const role = profile.serialRoles[index];
    if (
      !/<target\b[^>]*\btype=(['"])usb-serial\1/.test(definition) ||
      !xmlAttributeEquals(definition, "port", String(index)) ||
      !/<address\b[^>]*\btype=(['"])usb\1/.test(definition) ||
      !xmlAttributeEquals(
        definition,
        "port",
        String(profile.serialUsbPorts[index]),
      )
    ) {
      throw new Error(`defined domain USB serial role ${role} is invalid`);
    }
    return role;
  });
  return {
    audio: {
      model: profile.audio.model,
      backend: profile.audio.backend,
      defaultDevice: profile.audio.defaultDevice,
    },
    serialRoles,
    serialUsbPorts: [...profile.serialUsbPorts],
  };
}

async function verifyDefinedRuntimeDevicesForDomain(
  config,
  domainName,
  profile,
) {
  const { stdout } = await run("virsh", [
    "--connect",
    config.host.libvirtUri,
    "dumpxml",
    domainName,
  ]);
  return verifyDefinedRuntimeDevices(stdout, profile);
}

export async function waitForGuestVerification(
  config,
  domainName,
  stagingDirectory,
  dependencies = {},
) {
  const verificationPath =
    "C:\\ProgramData\\WindowsRuntimeBaseline\\verification.json";
  const localReport = join(stagingDirectory, "verification.json");
  const runCommand = dependencies.runCommand ?? run;
  const interactiveDisplay = await waitForInteractiveDisplayReport(
    config,
    domainName,
    stagingDirectory,
    dependencies,
  );
  const { sshOptions, target } = interactiveDisplay;
  const preparationScript = join(stagingDirectory, "prepare-toolchain.ps1");
  await writeFile(
    preparationScript,
    `& 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode PrepareToolchain\n`,
    { mode: 0o600 },
  );
  await runCommand("scp", [
    ...sshOptions,
    preparationScript,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/prepare-toolchain.ps1`,
  ]);
  await runCommand("ssh", [
    ...sshOptions,
    target,
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\prepare-toolchain.ps1",
  ]);
  const token = await acquireRunnerRegistrationToken(config, { runCommand });
  const runnerName = `${config.runner.name}-${randomUUID().slice(0, 8)}`;
  const runnerScript = join(stagingDirectory, "register-runner.ps1");
  await writeFile(
    runnerScript,
    `& 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode RegisterRunner -RunnerArchivePath 'C:\\ProgramData\\WindowsRuntimeBaseline\\media\\${RUNNER_ARCHIVE_FILE}' -RunnerUrl ${powershellScriptLiteral(config.runner.url)} -RunnerRegistrationToken ${powershellScriptLiteral(token)} -RunnerName ${powershellScriptLiteral(runnerName)}\n`,
    { mode: 0o600 },
  );
  await runCommand("scp", [
    ...sshOptions,
    runnerScript,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/register-runner.ps1`,
  ]);
  await runCommand("ssh", [
    ...sshOptions,
    target,
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\register-runner.ps1",
  ]);
  await runCommand("ssh", [
    ...sshOptions,
    target,
    verificationCommand({ config, runnerName, verificationPath }),
  ]);
  await runCommand("scp", [
    ...sshOptions,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/verification.json`,
    localReport,
  ]);
  const report = readJsonWithBom(await readFile(localReport, "utf8"));
  if (report.ok !== true)
    throw new Error("guest prerequisite verification reported failure");
  return report;
}

async function acquireRunnerRegistrationToken(
  config,
  { runCommand = run } = {},
) {
  const provider = config.runner.registrationTokenProvider;
  const result = await runCommand(provider.command, provider.arguments ?? []);
  const token = result.stdout.trim();
  if (!token || /\s/.test(token)) {
    throw new Error(
      "runner registration token provider returned an invalid token",
    );
  }
  return token;
}

async function domainState(config) {
  const result = await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "domstate", config.vm.name],
    { allowFailure: true },
  );
  return result.failed ? null : result.stdout.trim().toLowerCase();
}

async function destroyAndUndefine(
  config,
  domainName,
  { runCommand = run } = {},
) {
  await runCommand(
    "virsh",
    ["--connect", config.host.libvirtUri, "destroy", domainName],
    { allowFailure: true },
  );
  await runCommand(
    "virsh",
    ["--connect", config.host.libvirtUri, "undefine", domainName],
    { allowFailure: true },
  );
}

function constructionCleanup({
  cacheStagingDirectory,
  config,
  constructionDomain,
  runCommand = run,
  stagingDirectory,
}) {
  let cleanupPromise = null;
  return () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await destroyAndUndefine(config, constructionDomain, { runCommand });
      await rm(stagingDirectory, { recursive: true, force: true });
      await rm(cacheStagingDirectory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
}

export async function runWithConstructionSignalCleanup({
  cleanup,
  exitOnSignal = false,
  exitProcess = process.exit,
  work,
}) {
  let cleanupPromise = null;
  let termination = null;
  let rejectTermination;
  const cleanupOnce = () => {
    if (!cleanupPromise) cleanupPromise = Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
  const terminated = new Promise((_, reject) => {
    rejectTermination = reject;
  });
  const handleSignal = (signal) => {
    if (termination) return;
    termination = new Error(`construction build received ${signal}`);
    void cleanupOnce().then(
      () => {
        if (exitOnSignal) {
          exitProcess(signal === "SIGTERM" ? 143 : 130);
          return;
        }
        rejectTermination(termination);
      },
      (error) => rejectTermination(error),
    );
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  try {
    return await Promise.race([Promise.resolve().then(work), terminated]);
  } finally {
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
    if (termination) await cleanupOnce();
  }
}

export async function recoverStaleConstructionDomains(
  config,
  { runCommand = run } = {},
) {
  const result = await runCommand("virsh", [
    "--connect",
    config.host.libvirtUri,
    "list",
    "--all",
    "--name",
  ]);
  const constructionPrefix = `${config.vm.name}-build-`;
  const constructionDomains = result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.startsWith(constructionPrefix));
  for (const domainName of constructionDomains) {
    await runCommand(
      "virsh",
      ["--connect", config.host.libvirtUri, "destroy", domainName],
      { allowFailure: true },
    );
    await runCommand(
      "virsh",
      ["--connect", config.host.libvirtUri, "undefine", domainName],
      { allowFailure: true },
    );
  }
}

async function shutdownGuestAndWait(config, domainName, stagingDirectory) {
  const address = await discoverGuestAddress(config, domainName);
  if (!address) throw new Error("guest DHCP lease disappeared before shutdown");
  const target = `${config.guest.sshUser}@${address}`;
  await run("ssh", [
    ...guestSshOptions(config, join(stagingDirectory, "known_hosts")),
    target,
    "shutdown.exe /s /t 0 /f",
  ]);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (
      (await domainState({
        ...config,
        vm: { ...config.vm, name: domainName },
      })) === "shut off"
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("guest did not shut down cleanly within five minutes");
}

async function definePublishedDomain(config, release) {
  await run("virsh", [
    "--connect",
    config.host.libvirtUri,
    "define",
    release.domainXmlPath,
    "--validate",
  ]);
}

async function defineAndVerifyPublishedDomain(config, release) {
  await definePublishedDomain(config, release);
  await verifyDefinedRuntimeDevicesForDomain(
    config,
    config.vm.name,
    runtimeProfileForPublishedRelease(config, release.releaseId),
  );
}

async function rollbackPublishedDefinition(config, previousRelease) {
  if (previousRelease) {
    await defineAndVerifyPublishedDomain(config, previousRelease);
    return;
  }
  await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "undefine", config.vm.name],
    { allowFailure: true },
  );
}

export async function buildWin10Baseline(
  config,
  { sourceCommit, execute = false, exitOnSignal = false } = {},
) {
  validateBaselineBuildConfig(config);
  if (execute) await recoverStaleConstructionDomains(config);
  const profile = runtimeProfileForConfig(config);
  const observation = await collectHostObservation(config);
  evaluateHostPreflight(config, observation);
  const plan = {
    schemaVersion: "win10-kvm-baseline-build-plan/v1",
    hostAddress: config.host.address,
    vmName: config.vm.name,
    sourceCommit: sourceCommit ?? null,
    baselinePath: config.storage.baselinePath,
    cacheDiskPath: config.storage.cacheDiskPath,
    profile,
    execute,
  };
  if (!execute) return plan;
  await mkdir(dirname(config.storage.baselinePath), { recursive: true });
  await mkdir(dirname(config.storage.cacheDiskPath), { recursive: true });
  const state = await domainState(config);
  if (state && state !== "shut off") {
    throw new Error(
      "the published baseline VM must be shut off before a rebuild",
    );
  }
  const publishedRelease = await recoverPublishedBaseline(config, {
    recoverDefinition: async (release) =>
      defineAndVerifyPublishedDomain(config, release),
    rollbackDefinition: async (previousRelease) =>
      rollbackPublishedDefinition(config, previousRelease),
  });
  if (publishedRelease) {
    await defineAndVerifyPublishedDomain(config, publishedRelease);
  }
  await assertReadableRegularFile(
    config.guest.administratorPasswordFile,
    "guest.administratorPasswordFile",
  );
  await assertReadableRegularFile(
    config.guest.authorizedKeysFile,
    "guest.authorizedKeysFile",
  );
  await assertReadableRegularFile(
    config.guest.sshPrivateKeyFile,
    "guest.sshPrivateKeyFile",
  );
  await assertReadableRegularFile(
    config.media.spiceGuestToolsInstallerPath,
    "media.spiceGuestToolsInstallerPath",
  );
  await assertFileSha256(
    config.media.runnerArchivePath,
    config.media.runnerArchiveSha256,
    "media.runnerArchivePath",
  );
  const stagingDirectory = await mkdtemp(
    join(
      dirname(config.storage.baselinePath),
      "." + config.vm.name + ".staging-",
    ),
  );
  const cacheStagingDirectory = await mkdtemp(
    join(
      dirname(config.storage.cacheDiskPath),
      "." + config.vm.name + ".cache-staging-",
    ),
  );
  const stagedPath = join(stagingDirectory, "system.qcow2");
  const stagedCachePath = join(cacheStagingDirectory, "cache.qcow2");
  const constructionDomain = `${config.vm.name}-build-${randomUUID().slice(0, 8)}`;
  const cleanup = constructionCleanup({
    config,
    constructionDomain,
    stagingDirectory,
    cacheStagingDirectory,
  });
  return runWithConstructionSignalCleanup({
    cleanup,
    exitOnSignal,
    work: async () => {
      try {
        await run("qemu-img", [
          "create",
          "-f",
          "qcow2",
          stagedPath,
          `${config.storage.systemDiskGiB}G`,
        ]);
        if (publishedRelease) {
          await run("qemu-img", [
            "convert",
            "-f",
            "qcow2",
            "-O",
            "qcow2",
            publishedRelease.cachePath,
            stagedCachePath,
          ]);
        } else {
          await run("qemu-img", [
            "create",
            "-f",
            "qcow2",
            stagedCachePath,
            `${config.storage.cacheDiskGiB}G`,
          ]);
        }
        const configurationIso = await createConfigurationMedia(
          config,
          stagingDirectory,
        );
        const constructionProfile = {
          ...profile,
          vmName: constructionDomain,
          disks: {
            ...profile.disks,
            system: { ...profile.disks.system, path: stagedPath },
            cache: { ...profile.disks.cache, path: stagedCachePath },
          },
        };
        const constructionXmlPath = join(
          stagingDirectory,
          "construction-domain.xml",
        );
        await writeFile(
          constructionXmlPath,
          renderLibvirtDomainXml(constructionProfile, {
            cdromPaths: [config.media.windowsIsoPath, configurationIso],
          }),
          { mode: 0o600 },
        );
        await run("virsh", [
          "--connect",
          config.host.libvirtUri,
          "define",
          constructionXmlPath,
        ]);
        await run("virsh", [
          "--connect",
          config.host.libvirtUri,
          "start",
          constructionDomain,
        ]);
        const verification = await waitForGuestVerification(
          config,
          constructionDomain,
          stagingDirectory,
        );
        const virtualDevices = await verifyDefinedRuntimeDevicesForDomain(
          config,
          constructionDomain,
          constructionProfile,
        );
        await shutdownGuestAndWait(
          config,
          constructionDomain,
          stagingDirectory,
        );
        await run("qemu-img", ["check", stagedPath]);
        await run("qemu-img", ["check", stagedCachePath]);
        await run("virsh", [
          "--connect",
          config.host.libvirtUri,
          "undefine",
          constructionDomain,
        ]);
        const nextReleaseId = `release-${randomUUID()}`;
        const publishedProfile = runtimeProfileForPublishedRelease(
          config,
          nextReleaseId,
        );
        const finalXmlPath = join(stagingDirectory, "runtime-profile.xml");
        await writeFile(
          finalXmlPath,
          renderLibvirtDomainXml(publishedProfile),
          {
            mode: 0o600,
          },
        );
        const diagnostic = {
          schemaVersion: "win10-kvm-baseline-diagnostic/v1",
          sourceCommit: sourceCommit ?? null,
          verifiedAt: new Date().toISOString(),
          profile: publishedProfile,
          verification,
          virtualDevices,
        };
        const stagedDiagnosticPath = join(stagingDirectory, "diagnostic.json");
        await writeFile(
          stagedDiagnosticPath,
          `${JSON.stringify(diagnostic, null, 2)}\n`,
          { mode: 0o600 },
        );
        const release = await publishVerifiedBaselineRelease({
          config,
          releaseId: nextReleaseId,
          stagedSystemPath: stagedPath,
          stagedCachePath,
          stagedDomainXmlPath: finalXmlPath,
          stagedDiagnosticPath,
          profile: publishedProfile,
          verified: verification.ok === true,
          commitDefinition: async (candidateRelease) => {
            await defineAndVerifyPublishedDomain(config, candidateRelease);
          },
          rollbackDefinition: async (previousRelease) => {
            await rollbackPublishedDefinition(config, previousRelease);
          },
        });
        return {
          ...plan,
          verification,
          promoted: true,
          publication: {
            currentManifestPath:
              baselinePublicationLayout(config).currentManifestPath,
            releaseId: release.releaseId,
          },
        };
      } finally {
        await cleanup();
      }
    },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const result = await buildWin10Baseline(config, {
    sourceCommit: options["source-commit"],
    execute: options.execute,
    exitOnSignal: true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
