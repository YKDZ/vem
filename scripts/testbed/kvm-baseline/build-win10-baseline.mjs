#!/usr/bin/env node

import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { renderLibvirtDomainXml } from "./libvirt-runtime-profile.mjs";
import {
  REQUIRED_COMMANDS,
  assertReadableRegularFile,
  evaluateHostPreflight,
  parseGuestAddress,
  readJsonWithBom,
  replaceFilesTransaction,
  runtimeProfileForConfig,
  validateBaselineBuildConfig,
} from "./linux-kvm-baseline.mjs";

const execFile = promisify(execFileCallback);
const BASELINE_ROOT = new URL(".", import.meta.url);
export const SPICE_GUEST_TOOLS_INSTALLER_FILE = "spice-guest-tools-0.141.exe";

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
      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$drive = (Get-CimInstance Win32_CDROMDrive | Where-Object { Test-Path (Join-Path $_.Drive 'baseline-config.json') } | Select-Object -First 1 -ExpandProperty Drive); if ([string]::IsNullOrWhiteSpace($drive)) { throw 'baseline configuration media is unavailable during specialize' }; $dest = 'C:\\ProgramData\\WindowsRuntimeBaseline\\media'; New-Item -ItemType Directory -Force -Path $dest | Out-Null; Copy-Item -Path (Join-Path $drive '*') -Destination $dest -Recurse -Force"</Path><Description>Stage runtime baseline media</Description></RunSynchronousCommand></RunSynchronous>
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
& (Join-Path $mediaRoot "shared-guest-preparation.ps1") -WebView2InstallerUri $config.webView2InstallerUri -SpiceGuestToolsInstallerPath (Join-Path $mediaRoot $config.spiceGuestToolsInstallerFile) -AuthorizedKeysPath (Join-Path $mediaRoot "administrators_authorized_keys") -DesktopWidth $config.display.width -DesktopHeight $config.display.height -DesktopScalePercent $config.display.scalePercent
`;
}

export function guestConfigurationFor(config) {
  return {
    webView2InstallerUri: config.media.webView2InstallerUri,
    spiceGuestToolsInstallerFile: SPICE_GUEST_TOOLS_INSTALLER_FILE,
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

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function waitForGuestVerification(config, domainName, stagingDirectory) {
  const verificationPath =
    "C:\\ProgramData\\WindowsRuntimeBaseline\\verification.json";
  const localReport = join(stagingDirectory, "verification.json");
  const knownHostsPath = join(stagingDirectory, "known_hosts");
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const address = await discoverGuestAddress(config, domainName);
    if (address) {
      const target = `${config.guest.sshUser}@${address}`;
      const sshOptions = guestSshOptions(config, knownHostsPath);
      const result = await run("ssh", [...sshOptions, target, "exit"], {
        allowFailure: true,
      });
      if (!result.failed) {
        const preparationScript = join(
          stagingDirectory,
          "prepare-toolchain.ps1",
        );
        await writeFile(
          preparationScript,
          `& 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode PrepareToolchain\n`,
          { mode: 0o600 },
        );
        await run("scp", [
          ...sshOptions,
          preparationScript,
          `${target}:C:/ProgramData/WindowsRuntimeBaseline/prepare-toolchain.ps1`,
        ]);
        await run("ssh", [
          ...sshOptions,
          target,
          "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\prepare-toolchain.ps1",
        ]);
        const token = await acquireRunnerRegistrationToken(config);
        const runnerName = `${config.runner.name}-${randomUUID().slice(0, 8)}`;
        const runnerScript = join(stagingDirectory, "register-runner.ps1");
        await writeFile(
          runnerScript,
          `& 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode RegisterRunner -RunnerArchiveUri ${powershellLiteral(config.media.runnerArchiveUri)} -RunnerUrl ${powershellLiteral(config.runner.url)} -RunnerRegistrationToken ${powershellLiteral(token)} -RunnerName ${powershellLiteral(runnerName)}\n`,
          { mode: 0o600 },
        );
        await run("scp", [
          ...sshOptions,
          runnerScript,
          `${target}:C:/ProgramData/WindowsRuntimeBaseline/register-runner.ps1`,
        ]);
        await run("ssh", [
          ...sshOptions,
          target,
          "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\register-runner.ps1",
        ]);
        await run("ssh", [
          ...sshOptions,
          target,
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\verify-vm-runtime.ps1 -ExpectedWidth 1080 -ExpectedHeight 1920 -ExpectedScalePercent ${config.guest.desktopScalePercent} -ExpectedInteractiveUser ${powershellLiteral(config.guest.sshUser)} -OutputPath ${verificationPath}`,
        ]);
        await run("scp", [
          ...sshOptions,
          `${target}:C:/ProgramData/WindowsRuntimeBaseline/verification.json`,
          localReport,
        ]);
        const report = readJsonWithBom(await readFile(localReport, "utf8"));
        if (report.ok !== true)
          throw new Error("guest prerequisite verification reported failure");
        return report;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    "timed out waiting for Windows guest prerequisite verification",
  );
}

async function acquireRunnerRegistrationToken(config) {
  const provider = config.runner.registrationTokenProvider;
  const result = await run(provider.command, provider.arguments ?? []);
  const token = result.stdout.trim();
  if (!token || /\s/.test(token)) {
    throw new Error(
      "runner registration token provider returned an invalid token",
    );
  }
  return token;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function domainState(config) {
  const result = await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "domstate", config.vm.name],
    { allowFailure: true },
  );
  return result.failed ? null : result.stdout.trim().toLowerCase();
}

async function destroyAndUndefine(config, domainName) {
  await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "destroy", domainName],
    { allowFailure: true },
  );
  await run(
    "virsh",
    ["--connect", config.host.libvirtUri, "undefine", domainName],
    { allowFailure: true },
  );
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

async function captureInactiveDomainXml(config) {
  const result = await run(
    "virsh",
    [
      "--connect",
      config.host.libvirtUri,
      "dumpxml",
      "--inactive",
      config.vm.name,
    ],
    { allowFailure: true },
  );
  return result.failed ? null : result.stdout;
}

async function restoreInactiveDomain(config, previousXml, stagingDirectory) {
  if (previousXml === null) {
    await run(
      "virsh",
      ["--connect", config.host.libvirtUri, "undefine", config.vm.name],
      { allowFailure: true },
    );
    return;
  }
  const previousXmlPath = join(
    stagingDirectory,
    "previous-inactive-domain.xml",
  );
  await writeFile(previousXmlPath, previousXml, { mode: 0o600 });
  await run("virsh", [
    "--connect",
    config.host.libvirtUri,
    "define",
    previousXmlPath,
    "--validate",
  ]);
}

export async function buildWin10Baseline(
  config,
  { sourceCommit, execute = false } = {},
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
  const publishedBaselineExists = await pathExists(config.storage.baselinePath);
  const persistentCacheExists = await pathExists(config.storage.cacheDiskPath);
  if (publishedBaselineExists && !persistentCacheExists) {
    throw new Error(
      "a published baseline requires its persistent cache disk before rebuild",
    );
  }
  const stagingDirectory = await mkdtemp(
    join(
      dirname(config.storage.baselinePath),
      "." + config.vm.name + ".staging-",
    ),
  );
  const cacheStagingDirectory = persistentCacheExists
    ? stagingDirectory
    : await mkdtemp(
        join(
          dirname(config.storage.cacheDiskPath),
          "." + config.vm.name + ".cache-staging-",
        ),
      );
  const stagedPath = join(stagingDirectory, "system.qcow2");
  const stagedCachePath = persistentCacheExists
    ? config.storage.cacheDiskPath
    : join(cacheStagingDirectory, "cache.qcow2");
  const constructionDomain = `${config.vm.name}-build-${randomUUID().slice(0, 8)}`;
  try {
    await run("qemu-img", [
      "create",
      "-f",
      "qcow2",
      stagedPath,
      `${config.storage.systemDiskGiB}G`,
    ]);
    if (!persistentCacheExists) {
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
    await shutdownGuestAndWait(config, constructionDomain, stagingDirectory);
    await run("qemu-img", ["check", stagedPath]);
    await run("qemu-img", ["check", stagedCachePath]);
    await run("virsh", [
      "--connect",
      config.host.libvirtUri,
      "undefine",
      constructionDomain,
    ]);
    const finalXmlPath = join(stagingDirectory, "runtime-profile.xml");
    await writeFile(finalXmlPath, renderLibvirtDomainXml(profile), {
      mode: 0o600,
    });
    const previousInactiveXml = await captureInactiveDomainXml(config);
    const diagnostic = {
      schemaVersion: "win10-kvm-baseline-diagnostic/v1",
      sourceCommit: sourceCommit ?? null,
      verifiedAt: new Date().toISOString(),
      profile,
      verification,
    };
    const stagedDiagnosticPath = join(stagingDirectory, "diagnostic.json");
    await writeFile(
      stagedDiagnosticPath,
      `${JSON.stringify(diagnostic, null, 2)}\n`,
      { mode: 0o600 },
    );
    const stagedStableXmlPath = join(stagingDirectory, "stable-domain.xml");
    await copyFile(finalXmlPath, stagedStableXmlPath);
    const publication = [
      { stagedPath, destinationPath: config.storage.baselinePath },
      {
        stagedPath: stagedDiagnosticPath,
        destinationPath: `${config.storage.baselinePath}.diagnostic.json`,
      },
      {
        stagedPath: stagedStableXmlPath,
        destinationPath: `${config.storage.baselinePath}.domain.xml`,
      },
    ];
    if (!persistentCacheExists)
      publication.splice(1, 0, {
        stagedPath: stagedCachePath,
        destinationPath: config.storage.cacheDiskPath,
      });
    let stableDomainPublicationStarted = false;
    try {
      await replaceFilesTransaction(publication, async (_entry, count) => {
        if (count === publication.length) {
          stableDomainPublicationStarted = true;
          await run("virsh", [
            "--connect",
            config.host.libvirtUri,
            "define",
            `${config.storage.baselinePath}.domain.xml`,
            "--validate",
          ]);
        }
      });
    } catch (error) {
      if (stableDomainPublicationStarted) {
        await restoreInactiveDomain(
          config,
          previousInactiveXml,
          stagingDirectory,
        );
      }
      throw error;
    }
    return { ...plan, verification, promoted: true };
  } catch (error) {
    await destroyAndUndefine(config, constructionDomain);
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (cacheStagingDirectory !== stagingDirectory) {
      await rm(cacheStagingDirectory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const result = await buildWin10Baseline(config, {
    sourceCommit: options["source-commit"],
    execute: options.execute,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
