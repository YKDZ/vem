#!/usr/bin/env node

import {
  execFile as execFileCallback,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, hostname, networkInterfaces } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { renderLibvirtDomainXml } from "./libvirt-runtime-profile.ts";
import {
  REQUIRED_COMMANDS,
  assertFileSha256,
  assertReadableRegularFile,
  baselinePublicationLayout,
  evaluateHostPreflight,
  parseGuestAddress,
  publishVerifiedBaselineRelease,
  readJsonWithBom,
  recoverHeadlessVncActivator,
  recoverPublishedBaseline,
  runtimeProfileForConfig,
  runtimeProfileForPublishedRelease,
  startHeadlessVncActivator,
  validateBaselineBuildConfig,
  VNC_ACTIVATOR_METADATA_FILE,
  type BaselineBuildConfig,
} from "./linux-kvm-baseline.ts";

const BASELINE_ROOT = new URL(".", import.meta.url);
const CONSTRUCTION_OWNER_FILE = ".construction-owner.json";
const CONSTRUCTION_OWNER_SCHEMA = "win10-kvm-construction-owner/v1";
export const RUNNER_ARCHIVE_FILE = "actions-runner-win-x64.zip";
export const VIRTIO_GPU_DRIVER_DIRECTORY = "virtio-gpu-driver";
export const VIRTIO_GPU_DRIVER_IDENTITY_FILE =
  "virtio-gpu-driver-identity.json";
const INTERACTIVE_DISPLAY_REPORT_PATH =
  "C:\\ProgramData\\WindowsRuntimeBaseline\\interactive-display-report.json";
const GUEST_AVAILABILITY_TIMEOUT_MS = 60 * 60 * 1000;
const INTERACTIVE_DISPLAY_STAGE_TIMEOUT_MS = 20 * 60 * 1000;
const INTERACTIVE_DISPLAY_POLL_INTERVAL_MS = 10 * 1000;
const INTERACTIVE_DISPLAY_INITIAL_REARM_DELAY_MS = 60 * 1000;
const INTERACTIVE_DISPLAY_MAX_REARM_ATTEMPTS = 2;
const PREPARE_VM_RUNTIME_SCRIPT =
  "C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1";

type ProtectedBuildConfig = BaselineBuildConfig & {
  __secrets: { administratorPassword: unknown };
};

type CommandResult = {
  stdout: string;
  stderr: string;
  failed?: boolean;
};

type ConstructionWorkspace = {
  schemaVersion: string;
  buildId: string;
  vmName: string;
  domainName: string;
  baselinePath: string;
  cacheDiskPath: string;
  systemStagingPath: string;
  cacheStagingPath: string;
};

type VirtioGpuDriverPackageIdentity = {
  schemaVersion: string;
  sourceDirectory: string;
  packageSha256: string;
  files: Array<{ path: string; sha256: string }>;
  driverStoreFiles: Array<{ path: string; sha256: string }>;
};

type ParsedArgs = {
  execute: boolean;
  config: string;
  "source-commit"?: string;
  [key: string]: string | boolean | undefined;
};

function parseArgs(argv: string[]): ParsedArgs {
  const options: ParsedArgs = { execute: false, config: "" };
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
    typeof options["source-commit"] === "string" &&
    !/^[0-9a-f]{7,64}$/i.test(options["source-commit"])
  ) {
    throw new Error("--source-commit must be a Git commit SHA");
  }
  return options;
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function constructionWorkspace(
  config: BaselineBuildConfig,
  buildId: string,
): ConstructionWorkspace {
  const domainName = `${String(config.vm.name)}-build-${buildId}`;
  const systemStagingPath = join(
    dirname(String(config.storage.baselinePath)),
    `.${String(config.vm.name)}.staging-${buildId}`,
  );
  const cacheStagingPath = join(
    dirname(String(config.storage.cacheDiskPath)),
    `.${String(config.vm.name)}.cache-staging-${buildId}`,
  );
  return {
    schemaVersion: CONSTRUCTION_OWNER_SCHEMA,
    buildId,
    vmName: String(config.vm.name),
    domainName,
    baselinePath: String(config.storage.baselinePath),
    cacheDiskPath: String(config.storage.cacheDiskPath),
    systemStagingPath,
    cacheStagingPath,
  };
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeConstructionOwner(
  path: string,
  owner: ConstructionWorkspace,
): Promise<void> {
  const metadataPath = join(path, CONSTRUCTION_OWNER_FILE);
  await writeFile(metadataPath, `${JSON.stringify(owner, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await syncPath(metadataPath);
  await syncPath(path);
}

export async function createConstructionWorkspace(
  config: BaselineBuildConfig,
  {
    nextBuildId = () => randomUUID().replaceAll("-", "").slice(0, 8),
  }: { nextBuildId?: () => string } = {},
): Promise<ConstructionWorkspace> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const buildId = nextBuildId();
    if (!/^[0-9a-f]{8}$/.test(buildId)) {
      throw new Error(
        "construction build identity must be eight lowercase hex characters",
      );
    }
    const owner = constructionWorkspace(config, buildId);
    try {
      await mkdir(owner.systemStagingPath, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "EEXIST") continue;
      throw error;
    }
    let cacheCreated = false;
    try {
      await mkdir(owner.cacheStagingPath, { mode: 0o700 });
      cacheCreated = true;
      await writeConstructionOwner(owner.systemStagingPath, owner);
      await writeConstructionOwner(owner.cacheStagingPath, owner);
      return owner;
    } catch (error) {
      await rm(owner.systemStagingPath, { recursive: true, force: true });
      if (cacheCreated) {
        await rm(owner.cacheStagingPath, { recursive: true, force: true });
      }
      if ((error as { code?: unknown })?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("could not allocate a unique construction workspace");
}

function constructionOwnerMatches(
  observed: unknown,
  expected: Record<string, unknown>,
): boolean {
  const record = observed as Record<string, unknown> | null;
  return (
    record !== null &&
    typeof record === "object" &&
    Object.keys(expected).every((key) => record[key] === expected[key]) &&
    Object.keys(record).length === Object.keys(expected).length
  );
}

async function isOwnedConstructionDirectory(
  path: string,
  owner: ConstructionWorkspace,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const observed = JSON.parse(
      await readFile(join(path, CONSTRUCTION_OWNER_FILE), "utf8"),
    );
    return constructionOwnerMatches(observed, owner);
  } catch {
    return false;
  }
}

async function reclaimConstructionWorkspace(
  config: BaselineBuildConfig,
  buildId: string,
): Promise<boolean> {
  const owner = constructionWorkspace(config, buildId);
  const [systemOwned, cacheOwned] = await Promise.all([
    isOwnedConstructionDirectory(owner.systemStagingPath, owner),
    isOwnedConstructionDirectory(owner.cacheStagingPath, owner),
  ]);
  if (!systemOwned || !cacheOwned) return false;
  const activator = await recoverHeadlessVncActivator({
    metadataPath: join(owner.systemStagingPath, VNC_ACTIVATOR_METADATA_FILE),
    owner,
  });
  if (!activator.recovered) return false;
  await Promise.all([
    rm(owner.systemStagingPath, { recursive: true, force: true }),
    rm(owner.cacheStagingPath, { recursive: true, force: true }),
  ]);
  return true;
}

let activeConstructionCommandTracker: ReturnType<
  typeof createConstructionCommandTracker
> | null = null;

function startExecFile(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): {
  child: ChildProcess;
  completion: Promise<CommandResult>;
} {
  let child!: ChildProcess;
  const completion = new Promise<CommandResult>((resolve, reject) => {
    child = execFileCallback(
      command,
      args,
      {
        maxBuffer: 1024 * 1024,
        ...options,
      } as Parameters<typeof execFileCallback>[2],
      (error, stdout, stderr) => {
        if (error) {
          error.stdout ??= stdout;
          error.stderr ??= stderr;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  return { child, completion };
}

export function createConstructionCommandTracker({
  terminationGraceMs = 2_000,
}: { terminationGraceMs?: number } = {}): {
  abortAndWait: () => Promise<void>;
  run: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<CommandResult>;
  runCleanup: (
    command: string,
    args: string[],
    options?: { allowFailure?: boolean },
  ) => Promise<CommandResult>;
  start: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => { child: ChildProcess; completion: Promise<CommandResult> };
} {
  const inFlight = new Map<
    ChildProcess,
    { child: ChildProcess; completion: Promise<CommandResult> }
  >();
  let abortError: Error | null = null;
  let abortPromise: Promise<void> | null = null;

  const startTrackedProcess = (
    command: string,
    args: string[],
    { allowAfterAbort = false, ...options }: Record<string, unknown> & {
      allowAfterAbort?: boolean;
    } = {},
  ): { child: ChildProcess; completion: Promise<CommandResult> } => {
    if (abortError && !allowAfterAbort) throw abortError;
    const invocation = startExecFile(command, args, options);
    inFlight.set(invocation.child, invocation);
    void invocation.completion.then(
      () => inFlight.delete(invocation.child),
      () => inFlight.delete(invocation.child),
    );
    return invocation;
  };

  const runTrackedCommand = (
    command: string,
    args: string[],
    options: Record<string, unknown> = {},
  ): Promise<CommandResult> => {
    try {
      return startTrackedProcess(command, args, options).completion;
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const runCleanupCommand = (
    command: string,
    args: string[],
    { allowFailure = false }: { allowFailure?: boolean } = {},
  ): Promise<CommandResult> =>
    runTrackedCommand(command, args, { allowAfterAbort: true }).catch(
      (error: unknown) => {
        const err = error as { stdout?: unknown; stderr?: unknown };
        if (!allowFailure) throw error;
        return {
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? ""),
          failed: true,
        };
      },
    );

  const abortAndWait = (): Promise<void> => {
    if (abortPromise) return abortPromise;
    abortError = new Error("construction command execution was aborted");
    const pending = [...inFlight.values()];
    const terminate = async ({
      child,
      completion,
    }: {
      child: ChildProcess;
      completion: Promise<CommandResult>;
    }): Promise<void> => {
      const exited = new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit();
          return;
        }
        child.once("exit", resolveExit);
        child.once("error", resolveExit);
      });
      const awaitExitWithinGrace = (): Promise<boolean> =>
        new Promise<boolean>((resolveWait) => {
          const timeout = setTimeout(
            () => resolveWait(false),
            terminationGraceMs,
          );
          void exited.then(() => {
            clearTimeout(timeout);
            resolveWait(true);
          });
        });
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      const exitedAfterTerm = await awaitExitWithinGrace();
      if (
        !exitedAfterTerm &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill("SIGKILL");
      }
      if (!exitedAfterTerm && !(await awaitExitWithinGrace())) {
        throw new Error(`child ${child.pid} did not exit`);
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      inFlight.delete(child);
      void completion.catch(() => undefined);
    };
    abortPromise = Promise.all(pending.map(terminate)).then(() => undefined);
    return abortPromise;
  };

  return {
    abortAndWait,
    run: runTrackedCommand,
    runCleanup: runCleanupCommand,
    start: startTrackedProcess,
  };
}

function run(
  command: string,
  args: string[],
  { allowFailure = false }: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const completion = activeConstructionCommandTracker
    ? activeConstructionCommandTracker.run(command, args)
    : startExecFile(command, args).completion;
  return completion.catch((error: unknown) => {
    const err = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    if (allowFailure)
      return {
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
        failed: true,
      };
    const diagnostics = [
      err.code !== undefined ? `exit=${String(err.code)}` : null,
      err.stdout ? `stdout:\n${String(err.stdout)}` : null,
      err.stderr ? `stderr:\n${String(err.stderr)}` : null,
      !err.stdout && !err.stderr ? String(err.message ?? "") : null,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${command} failed:\n${diagnostics}`);
  });
}

async function existingParent(path: string): Promise<string> {
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

async function availableStorage(path: string): Promise<{
  availableBytes: number;
  filesystemId: string;
}> {
  const parent = await existingParent(path);
  const [filesystem, metadata] = await Promise.all([
    statfs(parent),
    stat(parent),
  ]);
  return {
    availableBytes: Number(filesystem.bavail) * Number(filesystem.bsize),
    filesystemId: `device:${metadata.dev}`,
  };
}

async function readable(path: string): Promise<boolean> {
  try {
    await assertReadableRegularFile(path, path);
    return true;
  } catch {
    return false;
  }
}

async function kvmDeviceAvailable(): Promise<boolean> {
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
    return (await stat("/dev/kvm")).isCharacterDevice();
  } catch {
    return false;
  }
}

async function collectExecutingHostIdentity(
  configuredAddress: string,
): Promise<Record<string, string[]>> {
  const hostnames = new Set([hostname().toLowerCase()]);
  const fqdn = await run("hostname", ["-f"], { allowFailure: true });
  if (!fqdn.failed && fqdn.stdout.trim())
    hostnames.add(fqdn.stdout.trim().toLowerCase());
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address) addresses.add(entry.address.toLowerCase());
    }
  }
  const resolvedConfiguredAddresses = new Set<string>(
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

function commandExists(command: string): boolean {
  return (
    spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" })
      .status === 0
  );
}

async function collectHostObservation(
  config: BaselineBuildConfig,
): Promise<Record<string, unknown>> {
  const profile = runtimeProfileForConfig(config);
  const commands = REQUIRED_COMMANDS.filter(commandExists);
  const network = await run(
    "virsh",
    [
      "--connect",
      String(config.host.libvirtUri),
      "net-info",
      String(config.vm.networkName),
    ],
    { allowFailure: true },
  );
  const libvirt = await run(
    "virsh",
    ["--connect", String(config.host.libvirtUri), "uri"],
    {
      allowFailure: true,
    },
  );
  const memory = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const availableMemoryKiB = Number(
    /^MemAvailable:\s+(\d+)/m.exec(memory)?.[1] ?? 0,
  );
  const [baselineStorage, cacheStorage] = await Promise.all([
    availableStorage(String(config.storage.baselinePath)),
    availableStorage(String(config.storage.cacheDiskPath)),
  ]);
  return {
    hostIdentity: await collectExecutingHostIdentity(
      String(config.host.address),
    ),
    kvmAvailable: await kvmDeviceAvailable(),
    libvirtAvailable: !libvirt.failed,
    commands,
    cpuCount: availableParallelism(),
    availableMemoryMiB: Math.floor(availableMemoryKiB / 1024),
    storageAvailableBytes: {
      baseline: baselineStorage.availableBytes,
      cache: cacheStorage.availableBytes,
    },
    storageFilesystemIds: {
      baseline: baselineStorage.filesystemId,
      cache: cacheStorage.filesystemId,
    },
    installationMedia: {
      windowsIso: await readable(String(config.media.windowsIsoPath)),
      virtioWinIso: await readable(String(config.media.virtioWinIsoPath)),
      runnerArchive: await assertFileSha256(
        String(config.media.runnerArchivePath),
        String(config.media.runnerArchiveSha256),
        "media.runnerArchivePath",
      )
        .then(() => true)
        .catch(() => false),
    },
    networkActive: !network.failed && /^Active:\s+yes$/im.test(network.stdout),
    profile,
  };
}

export function renderUnattendedXml(config: ProtectedBuildConfig): string {
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
try {
  & (Join-Path $mediaRoot "shared-guest-preparation.ps1") -WebView2InstallerUri $config.webView2InstallerUri -AuthorizedKeysPath (Join-Path $mediaRoot "administrators_authorized_keys")
  & (Join-Path $mediaRoot "prepare-vm-runtime.ps1") -Mode PrepareKvmGuest -VirtioGpuDriverPath (Join-Path $mediaRoot $config.virtioGpuDriverDirectory) -VirtioGpuDriverIdentityPath (Join-Path $mediaRoot $config.virtioGpuDriverIdentityFile) -InteractiveUser $config.interactiveUser -DesktopWidth $config.display.width -DesktopHeight $config.display.height -DesktopScalePercent $config.display.scalePercent
} catch {
  @{
    schemaVersion = "win10-kvm-bootstrap-failure/v1"
    failedAt = (Get-Date).ToUniversalTime().ToString("o")
    message = $_.Exception.Message
    type = $_.Exception.GetType().FullName
    stack = $_.ScriptStackTrace
  } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "C:\\ProgramData\\WindowsRuntimeBaseline\\bootstrap-failure.json"
  throw
}
`;
}

export function guestConfigurationFor(
  config: BaselineBuildConfig,
): Record<string, unknown> {
  return {
    webView2InstallerUri: config.media.webView2InstallerUri,
    runnerArchiveFile: RUNNER_ARCHIVE_FILE,
    virtioGpuDriverDirectory: VIRTIO_GPU_DRIVER_DIRECTORY,
    virtioGpuDriverIdentityFile: VIRTIO_GPU_DRIVER_IDENTITY_FILE,
    interactiveUser: config.guest.sshUser,
    display: {
      width: 1080,
      height: 1920,
      scalePercent: config.guest.desktopScalePercent,
    },
  };
}

async function payloadFiles(
  root: string,
  directory = root,
): Promise<Array<{ path: string; absolutePath: string }>> {
  const files: Array<{ path: string; absolutePath: string }> = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await payloadFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("VirtIO GPU driver payload must contain only files");
    }
    files.push({
      path: relative(root, path).split(sep).join("/"),
      absolutePath: path,
    });
  }
  return files;
}

export async function createVirtioGpuDriverPackageIdentity(
  driverRoot: string,
): Promise<VirtioGpuDriverPackageIdentity> {
  const files = await payloadFiles(driverRoot);
  for (const extension of [".inf", ".cat", ".sys"]) {
    if (!files.some(({ path }) => path.toLowerCase().endsWith(extension))) {
      throw new Error(
        `VirtIO GPU driver payload is missing a signed ${extension} file`,
      );
    }
  }
  const identityFiles: Array<{ path: string; sha256: string }> = [];
  for (const file of files) {
    const sha256 = createHash("sha256")
      .update(await readFile(file.absolutePath))
      .digest("hex");
    identityFiles.push({ path: file.path, sha256 });
  }
  const packageSha256 = createHash("sha256")
    .update(
      identityFiles.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(""),
      "utf8",
    )
    .digest("hex");
  const driverStoreFiles = identityFiles.filter(({ path }) =>
    /\.(?:inf|cat|sys)$/i.test(path),
  );
  for (const extension of [".inf", ".cat", ".sys"]) {
    if (
      !driverStoreFiles.some(({ path }) =>
        path.toLowerCase().endsWith(extension),
      )
    ) {
      throw new Error(
        `VirtIO GPU driver payload cannot identify its DriverStore ${extension} file`,
      );
    }
  }
  return {
    schemaVersion: "win10-kvm-virtio-gpu-driver-package/v2",
    sourceDirectory: "viogpudo/w10/amd64",
    packageSha256,
    files: identityFiles,
    driverStoreFiles,
  };
}

export async function createConfigurationMedia(
  config: BaselineBuildConfig,
  stagingDirectory: string,
  { runCommand = run }: { runCommand?: typeof run } = {},
): Promise<{
  isoPath: string;
  virtioGpuDriverIdentity: VirtioGpuDriverPackageIdentity;
}> {
  await assertFileSha256(
    String(config.media.runnerArchivePath),
    String(config.media.runnerArchiveSha256),
    "media.runnerArchivePath",
  );
  const mediaRoot = join(stagingDirectory, "configuration-media");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  const virtioGpuDriverRoot = join(mediaRoot, VIRTIO_GPU_DRIVER_DIRECTORY);
  await runCommand("xorriso", [
    "-osirrox",
    "on",
    "-indev",
    String(config.media.virtioWinIsoPath),
    "-extract",
    "/viogpudo/w10/amd64",
    virtioGpuDriverRoot,
  ]);
  const virtioGpuDriverIdentity =
    await createVirtioGpuDriverPackageIdentity(virtioGpuDriverRoot);
  await writeFile(
    join(mediaRoot, VIRTIO_GPU_DRIVER_IDENTITY_FILE),
    `${JSON.stringify(virtioGpuDriverIdentity, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const name of [
    "shared-guest-preparation.ps1",
    "prepare-vm-runtime.ps1",
    "verify-vm-runtime.ps1",
  ]) {
    await copyFile(new URL(name, BASELINE_ROOT), join(mediaRoot, name));
  }
  const secrets = {
    administratorPassword: (
    await readFile(String(config.guest.administratorPasswordFile), "utf8")
    ).trim(),
  };
  if (!secrets.administratorPassword)
    throw new Error("administrator password file must not be empty");
  const protectedConfig: ProtectedBuildConfig = {
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
    String(config.guest.authorizedKeysFile),
    join(mediaRoot, "administrators_authorized_keys"),
  );
  await copyFile(
    String(config.media.runnerArchivePath),
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
  return { isoPath, virtioGpuDriverIdentity };
}

async function discoverGuestAddress(
  config: BaselineBuildConfig,
  domainName: string,
): Promise<string | null> {
  const command = [
    "--connect",
    String(config.host.libvirtUri),
    "domifaddr",
    domainName,
    "--source",
    "lease",
  ];
  const result = await run("virsh", command, { allowFailure: true });
  const fromDomainLease = result.failed
    ? null
    : parseGuestAddress(result.stdout, String(config.vm.macAddress));
  if (fromDomainLease) return fromDomainLease;
  const lease = await run(
    "virsh",
    [
      "--connect",
      String(config.host.libvirtUri),
      "net-dhcp-leases",
      String(config.vm.networkName),
    ],
    { allowFailure: true },
  );
  return lease.failed
    ? null
    : parseGuestAddress(lease.stdout, String(config.vm.macAddress));
}

function guestSshOptions(
  config: BaselineBuildConfig,
  knownHostsPath: string,
): string[] {
  return [
    "-i",
    String(config.guest.sshPrivateKeyFile),
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

function powershellScriptLiteral(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedPowerShellCommand(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function encodedPowerShellRequest(request: unknown): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

function prepareVmRuntimeCommand(request: Record<string, unknown>): string {
  const encodedRequest = encodedPowerShellRequest(request);
  const bindings = [
    "-Mode $request.Mode",
    "-InteractiveUser $request.InteractiveUser",
    "-DesktopWidth $request.DesktopWidth",
    "-DesktopHeight $request.DesktopHeight",
    "-DesktopScalePercent $request.DesktopScalePercent",
  ];
  return encodedPowerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedRequest}")) | ConvertFrom-Json`,
      `& "${PREPARE_VM_RUNTIME_SCRIPT}" ${bindings.join(" ")}`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("\r\n"),
  );
}

function interactiveDisplayStatusCommand(
  config: BaselineBuildConfig,
): string {
  return prepareVmRuntimeCommand({
    Mode: "GetInteractiveDisplayPreparationStatus",
    InteractiveUser: config.guest.sshUser,
    DesktopWidth: 1080,
    DesktopHeight: 1920,
    DesktopScalePercent: config.guest.desktopScalePercent,
  });
}

function rearmInteractiveDisplayCommand(
  config: BaselineBuildConfig,
): string {
  return prepareVmRuntimeCommand({
    Mode: "RearmInteractiveDisplay",
    InteractiveUser: config.guest.sshUser,
    DesktopWidth: 1080,
    DesktopHeight: 1920,
    DesktopScalePercent: config.guest.desktopScalePercent,
  });
}

function verificationCommand({
  config,
  expectedVirtioGpuDriverPackageSha256,
  runnerName,
  verificationPath,
}: {
  config: BaselineBuildConfig;
  expectedVirtioGpuDriverPackageSha256: string;
  runnerName: string;
  verificationPath: string;
}): string {
  const encodedRequest = encodedPowerShellRequest({
    ExpectedWidth: 1080,
    ExpectedHeight: 1920,
    ExpectedScalePercent: config.guest.desktopScalePercent,
    ExpectedInteractiveUser: config.guest.sshUser,
    ExpectedRunnerUrl: config.runner.url,
    ExpectedRunnerName: runnerName,
    ExpectedRunnerLabels: config.runner.labels,
    ExpectedVirtioGpuDriverPackageSha256: expectedVirtioGpuDriverPackageSha256,
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
      '& "C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\verify-vm-runtime.ps1" -ExpectedWidth $request.ExpectedWidth -ExpectedHeight $request.ExpectedHeight -ExpectedScalePercent $request.ExpectedScalePercent -ExpectedInteractiveUser $request.ExpectedInteractiveUser -ExpectedRunnerUrl $request.ExpectedRunnerUrl -ExpectedRunnerName $request.ExpectedRunnerName -ExpectedRunnerLabels @($request.ExpectedRunnerLabels) -ExpectedRunnerServiceName $runner.serviceName -ExpectedVirtioGpuDriverPackageSha256 $request.ExpectedVirtioGpuDriverPackageSha256 -ExpectedAudioModel $request.ExpectedAudioModel -ExpectedSerialRole @($request.ExpectedSerialRole) -ExpectedSerialUsbPort @($request.ExpectedSerialUsbPort) -OutputPath $request.OutputPath',
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("\r\n"),
  );
}

function validateInteractiveDisplayReport(
  report: unknown,
  config: BaselineBuildConfig,
): Record<string, unknown> {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("interactive display report is not an object");
  }
  const record = report as Record<string, unknown>;
  if (record.schemaVersion !== "win10-kvm-interactive-display/v1") {
    throw new Error("interactive display report schema is invalid");
  }
  const expectedUser = new RegExp(
    `\\\\${String(config.guest.sshUser).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i",
  );
  if (!expectedUser.test(String(record.interactiveUser ?? ""))) {
    throw new Error("interactive display report belongs to an unexpected user");
  }
  if (
    !Number.isInteger(record.interactiveSessionId) ||
    (record.interactiveSessionId as number) < 1
  ) {
    throw new Error(
      "interactive display report has an invalid session binding",
    );
  }
  const desktop = record.desktop as Record<string, unknown> | undefined;
  if (
    desktop?.width !== 1080 ||
    desktop?.height !== 1920 ||
    desktop?.scalePercent !== config.guest.desktopScalePercent
  ) {
    throw new Error(
      "interactive display report does not match the requested desktop",
    );
  }
  if (
    typeof record.displayAdapter !== "string" ||
    record.displayAdapter === ""
  ) {
    throw new Error(
      "interactive display report does not identify the active display adapter",
    );
  }
  return record;
}

function formatInteractiveDisplayDiagnostics(
  diagnostic: Record<string, unknown>,
): string {
  const status = (diagnostic.status ?? {}) as Record<string, unknown>;
  const task = (status.task ?? {}) as Record<string, unknown>;
  const state = (status.state ?? {}) as Record<string, unknown>;
  const cleanup = (status.cleanup ?? {}) as Record<string, unknown>;
  const parts = [
    `report=${status.reportPresent === true ? "present" : "absent"}`,
    `reportValid=${status.reportValid === true}`,
    `completionValid=${interactiveDisplayCompleted(status)}`,
    `phase=${String(state.phase ?? "unknown")}`,
    `task state=${String(task.state ?? "absent")}`,
    `lastTaskResult=${String(task.lastTaskResult ?? "unknown")}`,
    `taskRegistered=${cleanup.taskRegistered === true}`,
    `AutoAdminLogonEnabled=${cleanup.automaticLogonEnabled === true}`,
  ];
  if (diagnostic.error) parts.push(`error=${String(diagnostic.error)}`);
  const awaitingReboot = diagnostic.awaitingReboot as
    | Record<string, unknown>
    | undefined;
  if (awaitingReboot) {
    parts.push(
      `awaiting reboot from=${String(
        awaitingReboot.bootIdentity ?? "unknown",
      )} sshDown=${awaitingReboot.sshWentDown === true}`,
    );
  }
  if (status.taskLogTail)
    parts.push(`task log=${String(status.taskLogTail)}`);
  return parts.join(", ");
}

function interactiveDisplayCompleted(
  status: Record<string, unknown> | undefined,
): boolean {
  if (status?.reportValid !== true) return false;
  const state = status.state as Record<string, unknown> | undefined;
  const cleanup = status.cleanup as Record<string, unknown> | undefined;
  return (
    state?.phase === "complete" &&
    status.task !== null &&
    cleanup?.taskRegistered === true &&
    cleanup?.automaticLogonEnabled === true
  );
}

function shouldRearmInteractiveDisplay(
  status: Record<string, unknown>,
  sshReadyAt: number | null,
  now: number,
  delayMs: number,
): boolean {
  if (interactiveDisplayCompleted(status)) return false;
  if (status.reportValid === true) return true;
  const state = status.state as Record<string, unknown> | undefined;
  const task = status.task as Record<string, unknown> | undefined;
  if (state?.phase === "failed") return true;
  if (now - (sshReadyAt ?? 0) < delayMs) return false;
  return !task || task.state !== "Running";
}

type InteractiveDisplayWaitOptions = {
  displayStageTimeoutMs?: number;
  discoverGuestAddress?: typeof discoverGuestAddress;
  guestAvailabilityTimeoutMs?: number;
  initialRearmDelayMs?: number;
  maxRearmAttempts?: number;
  now?: () => number;
  pollIntervalMs?: number;
  runCommand?: typeof run;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
};

type GuestVerificationOptions = {
  runCommand?: typeof run;
  expectedVirtioGpuDriverPackageSha256?: string;
} & InteractiveDisplayWaitOptions;

export async function waitForInteractiveDisplayReport(
  config: BaselineBuildConfig,
  domainName: string,
  stagingDirectory: string,
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
  }: InteractiveDisplayWaitOptions = {},
): Promise<{
  address: string;
  report: Record<string, unknown>;
  sshOptions: string[];
  target: string;
}> {
  const localReport = join(stagingDirectory, "interactive-display-report.json");
  const knownHostsPath = join(stagingDirectory, "known_hosts");
  const availabilityStartedAt = now();
  const availabilityDeadline =
    availabilityStartedAt + guestAvailabilityTimeoutMs;
  const resolvedDisplayStageTimeoutMs =
    displayStageTimeoutMs ?? timeoutMs ?? INTERACTIVE_DISPLAY_STAGE_TIMEOUT_MS;
  let rearmAttempts = 0;
  let sshReadyAt: number | null = null;
  let displayStageStartedAt: number | null = null;
  let displayStageDeadline: number | null = null;
  let awaitingReboot: {
    bootIdentity: string;
    sshWentDown: boolean;
  } | null = null;
  let diagnostic: Record<string, unknown> = {
    error: "SSH has not become available",
  };

  while (true) {
    const currentTime = now();
    if (displayStageStartedAt === null && currentTime >= availabilityDeadline) {
      throw new Error(
        `guest availability timed out after ${guestAvailabilityTimeoutMs} ms; ${formatInteractiveDisplayDiagnostics(diagnostic)}`,
      );
    }
    if (displayStageDeadline !== null && currentTime >= displayStageDeadline) {
      throw new Error(
        `interactive display preparation timed out: interactive display stage timed out after ${resolvedDisplayStageTimeoutMs} ms; first SSH readiness at ${(displayStageStartedAt ?? availabilityStartedAt) - availabilityStartedAt} ms; ${formatInteractiveDisplayDiagnostics(diagnostic)}`,
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

    const target = `${String(config.guest.sshUser)}@${address}`;
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

    let status: Record<string, unknown>;
    try {
      status = readJsonWithBom(statusResult.stdout ?? "") as Record<string, unknown>;
      if (!status || typeof status !== "object") {
        throw new Error("status output is not a JSON object");
      }
      diagnostic = { status, awaitingReboot };
    } catch (error) {
      const err = error as { message?: unknown };
      diagnostic = {
        error: `invalid interactive display status: ${String(err.message ?? "")}`,
        awaitingReboot,
      };
      await sleep(pollIntervalMs);
      continue;
    }

    const guestStageFailure = status.guestStageFailure as
      | Record<string, unknown>
      | undefined;
    if (guestStageFailure) {
      const message =
        typeof guestStageFailure.message === "string"
          ? guestStageFailure.message
          : JSON.stringify(guestStageFailure);
      throw new Error(`initial KVM guest preparation failed: ${message}`);
    }

    const currentBootIdentity =
      typeof status.currentBootIdentity === "string" &&
      status.currentBootIdentity.trim() !== ""
        ? status.currentBootIdentity
        : null;

    if (awaitingReboot) {
      const bootIdentityChanged =
        currentBootIdentity !== null &&
        awaitingReboot.bootIdentity !== currentBootIdentity;
      if (!bootIdentityChanged) {
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
          const err = error as { message?: unknown };
          throw new Error(
            `interactive display report is invalid: ${String(err.message ?? "")}`,
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
      if (currentBootIdentity === null) {
        diagnostic = {
          status,
          error:
            "waiting for a guest boot identity before interactive display re-arm",
        };
      } else {
        rearmAttempts += 1;
        const rearm = await runCommand(
          "ssh",
          [...sshOptions, target, rearmInteractiveDisplayCommand(config)],
          { allowFailure: true },
        );
        let rearmCompletion = null;
        if (!rearm.failed) {
          try {
            const response = readJsonWithBom(
              rearm.stdout ?? "",
            ) as Record<string, unknown>;
            if (interactiveDisplayCompleted(response))
              rearmCompletion = response;
          } catch {
            // A reboot can close the SSH channel before PowerShell flushes JSON.
          }
        }
        if (rearmCompletion) {
          diagnostic = { status: rearmCompletion };
        } else {
          awaitingReboot = {
            bootIdentity: currentBootIdentity,
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
    }
    await sleep(pollIntervalMs);
  }
}

function xmlAttributeEquals(
  element: string,
  attribute: string,
  value: unknown,
): boolean {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${attribute}=(['\"])${escaped}\\1`).test(element);
}

// Libvirt pins each otherwise-identical QEMU USB serial device to a distinct
// controller port. The guest verifies those ports.
export function verifyDefinedRuntimeDevices(
  domainXml: unknown,
  profile: ReturnType<typeof runtimeProfileForConfig>,
): Record<string, unknown> {
  const xml = String(domainXml);
  const sounds = [...xml.matchAll(/<sound\b[^>]*>([\s\S]*?)<\/sound>/g)];
  const audioDevices = [...xml.matchAll(/<audio\b(?=[^>]*\btype=)[^>]*\/?>/g)];
  if (
    sounds.length !== 1 ||
    !xmlAttributeEquals(sounds[0][0], "model", profile.audio.model) ||
    !/<audio\b[^>]*\bid=(['"])1\1\s*\/>/.test(sounds[0][0]) ||
    audioDevices.length !== 1 ||
    !xmlAttributeEquals(audioDevices[0][0], "id", "1") ||
    !xmlAttributeEquals(audioDevices[0][0], "type", "file") ||
    !xmlAttributeEquals(audioDevices[0][0], "path", profile.audio.capturePath)
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
      defaultDevice: profile.audio.defaultDevice,
      capturePath: profile.audio.capturePath,
    },
    serialRoles,
    serialUsbPorts: [...profile.serialUsbPorts],
  };
}

async function verifyDefinedRuntimeDevicesForDomain(
  config: BaselineBuildConfig,
  domainName: string,
  profile: ReturnType<typeof runtimeProfileForConfig>,
): Promise<Record<string, unknown>> {
  const { stdout } = await run("virsh", [
    "--connect",
    String(config.host.libvirtUri),
    "dumpxml",
    domainName,
  ]);
  return verifyDefinedRuntimeDevices(stdout, profile);
}

export async function waitForGuestVerification(
  config: BaselineBuildConfig,
  domainName: string,
  stagingDirectory: string,
  dependencies: GuestVerificationOptions = {},
): Promise<Record<string, unknown>> {
  const verificationPath =
    "C:\\ProgramData\\WindowsRuntimeBaseline\\verification.json";
  const localReport = join(stagingDirectory, "verification.json");
  const runCommand = dependencies.runCommand ?? run;
  const expectedVirtioGpuDriverPackageSha256 =
    dependencies.expectedVirtioGpuDriverPackageSha256;
  if (
    typeof expectedVirtioGpuDriverPackageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedVirtioGpuDriverPackageSha256)
  ) {
    throw new Error("expected VirtIO GPU driver package identity is required");
  }
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
    `$ProgressPreference = "SilentlyContinue"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode PrepareToolchain
$stageExitCode = $LASTEXITCODE
if ($stageExitCode -ne 0) {
  $failurePath = 'C:\\ProgramData\\WindowsRuntimeBaseline\\guest-stage-failure.json'
  if (Test-Path -LiteralPath $failurePath) {
    [Console]::Error.WriteLine((Get-Content -Raw -LiteralPath $failurePath))
  }
  exit $stageExitCode
}
`,
    { mode: 0o600 },
  );
  await runCommand("scp", [
    ...sshOptions,
    preparationScript,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/prepare-toolchain.ps1`,
  ]);
  try {
    await runCommand("ssh", [
      ...sshOptions,
      target,
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\prepare-toolchain.ps1",
    ]);
  } catch (error) {
    const guestFailurePath = join(stagingDirectory, "guest-stage-failure.json");
    const copied = await runCommand(
      "scp",
      [
        ...sshOptions,
        `${target}:C:/ProgramData/WindowsRuntimeBaseline/guest-stage-failure.json`,
        guestFailurePath,
      ],
      { allowFailure: true },
    );
    let guestFailure: string | null = null;
    if (!copied.failed) {
      guestFailure = await readFile(guestFailurePath, "utf8").catch(() => null);
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        guestFailure ? `\nguest stage failure:\n${guestFailure}` : ""
      }`,
    );
  }
  const token = await acquireRunnerRegistrationToken(config, { runCommand });
  const runnerName = `${config.runner.name}-${randomUUID().slice(0, 8)}`;
  const runnerLabels = config.runner.labels
    .map((label) => powershellScriptLiteral(label))
    .join(", ");
  const runnerScript = join(stagingDirectory, "register-runner.ps1");
  await writeFile(
    runnerScript,
    `& 'C:\\ProgramData\\WindowsRuntimeBaseline\\scripts\\prepare-vm-runtime.ps1' -Mode RegisterRunner -RunnerArchivePath 'C:\\ProgramData\\WindowsRuntimeBaseline\\media\\${RUNNER_ARCHIVE_FILE}' -RunnerUrl ${powershellScriptLiteral(config.runner.url)} -RunnerRegistrationToken ${powershellScriptLiteral(token)} -RunnerName ${powershellScriptLiteral(runnerName)} -RunnerLabels @(${runnerLabels})\n`,
    { mode: 0o600 },
  );
  await runCommand("scp", [
    ...sshOptions,
    runnerScript,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/register-runner.ps1`,
  ]);
  try {
    await runCommand("ssh", [
      ...sshOptions,
      target,
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\WindowsRuntimeBaseline\\register-runner.ps1",
    ]);
  } catch (error) {
    const localFailurePath = join(
      stagingDirectory,
      "runner-registration-failure.json",
    );
    const copied = await runCommand(
      "scp",
      [
        ...sshOptions,
        `${target}:C:/ProgramData/WindowsRuntimeBaseline/guest-stage-failure.json`,
        localFailurePath,
      ],
      { allowFailure: true },
    );
      const detail = copied.failed
        ? null
        : await readFile(localFailurePath, "utf8").catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        detail ? `\nrunner registration failure:\n${detail}` : ""
      }`,
    );
  }
  try {
    await runCommand("ssh", [
      ...sshOptions,
      target,
      verificationCommand({
        config,
        expectedVirtioGpuDriverPackageSha256,
        runnerName,
        verificationPath,
      }),
    ]);
  } catch (error) {
    const copied = await runCommand(
      "scp",
      [
        ...sshOptions,
        `${target}:C:/ProgramData/WindowsRuntimeBaseline/verification.json`,
        localReport,
      ],
      { allowFailure: true },
    );
      const detail = copied.failed
        ? null
        : await readFile(localReport, "utf8").catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        detail ? `\nguest verification report:\n${detail}` : ""
      }`,
    );
  }
  await runCommand("scp", [
    ...sshOptions,
    `${target}:C:/ProgramData/WindowsRuntimeBaseline/verification.json`,
    localReport,
  ]);
  const report = readJsonWithBom(
    await readFile(localReport, "utf8"),
  ) as Record<string, unknown>;
  if (report.ok !== true)
    throw new Error("guest prerequisite verification reported failure");
  return report;
}

async function acquireRunnerRegistrationToken(
  config: BaselineBuildConfig,
  { runCommand = run }: { runCommand?: typeof run } = {},
): Promise<string> {
  const provider = config.runner.registrationTokenProvider;
  const result = await runCommand(
    String(provider.command),
    (provider.arguments as unknown[] | undefined)?.map((value) =>
      String(value),
    ) ?? [],
  );
  const token = String(result.stdout).trim();
  if (!token || /\s/.test(token)) {
    throw new Error(
      "runner registration token provider returned an invalid token",
    );
  }
  return token;
}

async function domainState(
  config: BaselineBuildConfig,
): Promise<string | null> {
  const result = await run(
    "virsh",
    [
      "--connect",
      String(config.host.libvirtUri),
      "domstate",
      String(config.vm.name),
    ],
    { allowFailure: true },
  );
  return result.failed ? null : result.stdout.trim().toLowerCase();
}

async function destroyAndUndefine(
  config: BaselineBuildConfig,
  domainName: string,
  { runCommand = run }: { runCommand?: typeof run } = {},
): Promise<void> {
  await runCommand(
    "virsh",
    ["--connect", String(config.host.libvirtUri), "destroy", domainName],
    { allowFailure: true },
  );
  await runCommand(
    "virsh",
    ["--connect", String(config.host.libvirtUri), "undefine", domainName],
    { allowFailure: true },
  );
  const remaining = await runCommand("virsh", [
    "--connect",
    String(config.host.libvirtUri),
    "list",
    "--all",
    "--name",
  ]);
  if (
    remaining.stdout
      .split("\n")
      .map((name) => name.trim())
      .includes(domainName)
  ) {
    throw new Error(
      `construction domain still exists after cleanup: ${domainName}`,
    );
  }
}

export function constructionCleanup({
  cacheStagingDirectory,
  config,
  constructionDomain,
  runCommand = run,
  stagingDirectory,
  stopActivator = async () => {},
}: {
  cacheStagingDirectory: string;
  config: BaselineBuildConfig;
  constructionDomain: string;
  runCommand?: typeof run;
  stagingDirectory: string;
  stopActivator?: () => Promise<unknown>;
}): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async (): Promise<void> => {
      await stopActivator();
      await destroyAndUndefine(config, constructionDomain, { runCommand });
      await rm(stagingDirectory, { recursive: true, force: true });
      await rm(cacheStagingDirectory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
}

export async function runWithConstructionSignalCleanup<T>({
  abortInFlight = async () => {},
  cleanup,
  exitOnSignal = false,
  exitProcess = process.exit,
  work,
}: {
  abortInFlight?: () => Promise<unknown>;
  cleanup: () => Promise<unknown>;
  exitOnSignal?: boolean;
  exitProcess?: (code?: number) => void;
  work: () => Promise<T>;
}): Promise<T> {
  let cleanupPromise: Promise<unknown> | null = null;
  let termination: Error | null = null;
  let rejectTermination: (error: unknown) => void = () => {};
  const cleanupOnce = (): Promise<unknown> => {
    if (!cleanupPromise) cleanupPromise = Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
  const terminated = new Promise<never>((_, reject) => {
    rejectTermination = reject;
  });
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (termination) return;
    termination = new Error(`construction build received ${signal}`);
    void (async () => {
      try {
        await abortInFlight();
        await cleanupOnce();
        if (exitOnSignal) {
          exitProcess(signal === "SIGTERM" ? 143 : 130);
          return;
        }
        rejectTermination(termination);
      } catch (error) {
        rejectTermination(error);
      }
    })();
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  try {
    return await Promise.race([Promise.resolve().then(work), terminated]);
  } finally {
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
    if (termination) {
      await abortInFlight();
      await cleanupOnce();
    }
  }
}

export async function recoverStaleConstructionDomains(
  config: BaselineBuildConfig,
  { runCommand = run }: { runCommand?: typeof run } = {},
): Promise<void> {
  const result = await runCommand("virsh", [
    "--connect",
    String(config.host.libvirtUri),
    "list",
    "--all",
    "--name",
  ]);
  const escapedVmName = String(config.vm.name).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const constructionDomainPattern = new RegExp(
    `^${escapedVmName}-build-[0-9a-f]{8}$`,
  );
  const listedDomains = result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  const remainingDomains = new Set(listedDomains);
  const constructionDomains = listedDomains.filter((name) =>
    constructionDomainPattern.test(name),
  );
  for (const domainName of constructionDomains) {
    await destroyAndUndefine(config, domainName, { runCommand });
    remainingDomains.delete(domainName);
  }

  let stagingEntries: Array<{
    name: string;
    isDirectory: () => boolean;
  }> = [];
  try {
    stagingEntries = await readdir(
      dirname(String(config.storage.baselinePath)),
      { withFileTypes: true },
    );
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
  }
  const stagingPattern = new RegExp(
    `^\\.${escapedVmName}\\.staging-([0-9a-f]{8})$`,
  );
  for (const entry of stagingEntries) {
    if (!entry.isDirectory()) continue;
    const match = stagingPattern.exec(entry.name);
    if (!match) continue;
    const domainName = `${String(config.vm.name)}-build-${String(match[1])}`;
    if (remainingDomains.has(domainName)) continue;
    await reclaimConstructionWorkspace(config, match[1]);
  }
}

async function shutdownGuestAndWait(
  config: BaselineBuildConfig,
  domainName: string,
  stagingDirectory: string,
): Promise<void> {
  const address = await discoverGuestAddress(config, domainName);
  if (!address) throw new Error("guest DHCP lease disappeared before shutdown");
  const target = `${String(config.guest.sshUser)}@${address}`;
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

async function definePublishedDomain(
  config: BaselineBuildConfig,
  release: Record<string, unknown>,
): Promise<void> {
  await run("virsh", [
    "--connect",
    String(config.host.libvirtUri),
    "define",
    String(release.domainXmlPath),
    "--validate",
  ]);
}

async function existingPublishedDomainUuid(
  config: BaselineBuildConfig,
): Promise<string | null> {
  const result = await run(
    "virsh",
    [
      "--connect",
      String(config.host.libvirtUri),
      "domuuid",
      String(config.vm.name),
    ],
    { allowFailure: true },
  );
  if (result.failed) return null;
  const uuid = result.stdout.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      uuid,
    )
  ) {
    throw new Error("existing published domain returned an invalid UUID");
  }
  return uuid;
}

async function defineAndVerifyPublishedDomain(
  config: BaselineBuildConfig,
  release: Record<string, unknown>,
): Promise<void> {
  await definePublishedDomain(config, release);
  await verifyDefinedRuntimeDevicesForDomain(
    config,
    String(config.vm.name),
    runtimeProfileForPublishedRelease(config, release.releaseId),
  );
}

async function rollbackPublishedDefinition(
  config: BaselineBuildConfig,
  previousRelease: Record<string, unknown> | null,
): Promise<void> {
  if (previousRelease) {
    await defineAndVerifyPublishedDomain(config, previousRelease);
    return;
  }
  await run(
    "virsh",
    [
      "--connect",
      String(config.host.libvirtUri),
      "undefine",
      String(config.vm.name),
    ],
    { allowFailure: true },
  );
}

export async function buildWin10Baseline(
  config: BaselineBuildConfig,
  options: { sourceCommit?: string; execute?: boolean; exitOnSignal?: boolean } = {},
): Promise<unknown> {
  const commandTracker = createConstructionCommandTracker();
  const previousCommandTracker = activeConstructionCommandTracker;
  activeConstructionCommandTracker = commandTracker;
  try {
    return await buildWin10BaselineImpl(config, {
      ...options,
      commandTracker,
    });
  } finally {
    activeConstructionCommandTracker = previousCommandTracker;
  }
}

async function buildWin10BaselineImpl(
  config: BaselineBuildConfig,
  {
    commandTracker,
    sourceCommit,
    execute = false,
    exitOnSignal = false,
  }: {
    commandTracker: ReturnType<typeof createConstructionCommandTracker>;
    sourceCommit?: string;
    execute?: boolean;
    exitOnSignal?: boolean;
  } = {
    commandTracker: createConstructionCommandTracker(),
  },
): Promise<Record<string, unknown>> {
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
  await mkdir(dirname(String(config.storage.baselinePath)), {
    recursive: true,
  });
  await mkdir(dirname(String(config.storage.cacheDiskPath)), {
    recursive: true,
  });
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
  await assertFileSha256(
    config.media.runnerArchivePath,
    config.media.runnerArchiveSha256,
    "media.runnerArchivePath",
  );
  const construction = await createConstructionWorkspace(config);
  const stagingDirectory = construction.systemStagingPath;
  const cacheStagingDirectory = construction.cacheStagingPath;
  const stagedPath = join(stagingDirectory, "system.qcow2");
  const stagedCachePath = join(cacheStagingDirectory, "cache.qcow2");
  const constructionDomain = construction.domainName;
  let vncActivator: Awaited<
    ReturnType<typeof startHeadlessVncActivator>
  > | null = null;
  const cleanup = constructionCleanup({
    config,
    constructionDomain,
    runCommand: commandTracker.runCleanup,
    stagingDirectory,
    cacheStagingDirectory,
    stopActivator: async () => {
      await vncActivator?.stop();
      vncActivator = null;
    },
  });
  return runWithConstructionSignalCleanup({
    abortInFlight: () => commandTracker.abortAndWait(),
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
            String(publishedRelease.cachePath),
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
        const configurationMedia = await createConfigurationMedia(
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
            cdromPaths: [
              String(config.media.windowsIsoPath),
              configurationMedia.isoPath,
            ],
          }),
          { mode: 0o600 },
        );
        await run("virsh", [
          "--connect",
          String(config.host.libvirtUri),
          "define",
          constructionXmlPath,
        ]);
        await run("virsh", [
          "--connect",
          String(config.host.libvirtUri),
          "start",
          constructionDomain,
        ]);
        vncActivator = await startHeadlessVncActivator({
          domainName: constructionDomain,
          libvirtUri: String(config.host.libvirtUri),
          runCommand: run,
          startProcess: commandTracker.start,
          commands: {
            width: profile.display.width,
            height: profile.display.height,
          },
          metadataPath: join(stagingDirectory, VNC_ACTIVATOR_METADATA_FILE),
          owner: construction,
        });
        const { verification, virtualDevices } =
          await vncActivator.runWhileActive(async () => ({
            verification: await waitForGuestVerification(
              config,
              constructionDomain,
              stagingDirectory,
              {
                expectedVirtioGpuDriverPackageSha256:
                  configurationMedia.virtioGpuDriverIdentity.packageSha256,
              },
            ),
            virtualDevices: await verifyDefinedRuntimeDevicesForDomain(
              config,
              constructionDomain,
              constructionProfile,
            ),
          }));
        await vncActivator.stop();
        vncActivator = null;
        await shutdownGuestAndWait(
          config,
          constructionDomain,
          stagingDirectory,
        );
        await run("qemu-img", ["check", stagedPath]);
        await run("qemu-img", ["check", stagedCachePath]);
        await run("virsh", [
          "--connect",
          String(config.host.libvirtUri),
          "undefine",
          constructionDomain,
        ]);
        const nextReleaseId = `release-${randomUUID()}`;
        const publishedProfile = runtimeProfileForPublishedRelease(
          config,
          nextReleaseId,
        );
        const finalXmlPath = join(stagingDirectory, "runtime-profile.xml");
        const publishedDomainUuid =
          (await existingPublishedDomainUuid(config)) ?? randomUUID();
        await writeFile(
          finalXmlPath,
          renderLibvirtDomainXml(publishedProfile, {
            domainUuid: publishedDomainUuid,
          }),
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
