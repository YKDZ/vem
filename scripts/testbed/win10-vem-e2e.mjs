#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const VEM_RESET_ROOTS = [
  "C:\\VEM\\bringup",
  "C:\\VEM\\updates",
  "C:\\VEM\\vision",
  "C:\\ProgramData\\VEM\\vending-daemon",
];

const VEM_RESET_FILES = [
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
];

const PROTECTED_PATH_PREFIXES = [
  "C:\\Windows",
  "C:\\Program Files\\Tailscale",
  "C:\\Program Files\\OpenSSH",
  "C:\\Program Files (x86)\\Microsoft\\EdgeWebView",
  "C:\\Users\\YKDZ",
  "C:\\ProgramData\\Tailscale",
  "C:\\ProgramData\\ssh",
];

const PROTECTED_SERVICE_NAMES = new Set(["tailscale", "sshd"]);
const ALLOWED_SCHEDULED_TASKS = new Set([
  "vemmachineui",
  "vemmaintenanceui",
  "vem\\startvisionserver",
]);

export function buildResetPlan() {
  return {
    stopServices: ["VemVendingDaemon"],
    unregisterScheduledTasks: [
      "VEMMachineUI",
      "VEMMaintenanceUI",
      "VEM\\StartVisionServer",
    ],
    removeDirectories: [...VEM_RESET_ROOTS],
    removeFiles: [...VEM_RESET_FILES],
    preservedResources: [
      "Windows OS",
      "display setup",
      "Tailscale",
      "OpenSSH",
      "WebView2",
      "YKDZ maintenance account",
      "base networking",
    ],
  };
}

export function assertResetPlanPreservesTestbed(plan) {
  const candidatePaths = [
    ...(plan.removeDirectories ?? []),
    ...(plan.removeFiles ?? []),
  ];

  for (const path of candidatePaths) {
    const normalized = String(path).replaceAll("/", "\\").toLowerCase();
    for (const protectedPrefix of PROTECTED_PATH_PREFIXES) {
      if (
        normalized === protectedPrefix.toLowerCase() ||
        normalized.startsWith(`${protectedPrefix.toLowerCase()}\\`)
      ) {
        throw new Error(
          `reset plan targets protected testbed resource: ${path}`,
        );
      }
    }
  }

  for (const service of plan.stopServices ?? []) {
    const normalized = String(service).toLowerCase();
    if (
      PROTECTED_SERVICE_NAMES.has(normalized) ||
      !normalized.startsWith("vem")
    ) {
      throw new Error(
        `reset plan targets protected testbed resource: service ${service}`,
      );
    }
  }

  for (const task of plan.unregisterScheduledTasks ?? []) {
    const normalized = String(task).replaceAll("/", "\\").toLowerCase();
    if (!ALLOWED_SCHEDULED_TASKS.has(normalized)) {
      throw new Error(
        `reset plan targets protected testbed resource: scheduled task ${task}`,
      );
    }
  }

  return plan;
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psArray(values) {
  return `@(${values.map(psString).join(", ")})`;
}

function splitTaskName(taskName) {
  const index = taskName.lastIndexOf("\\");
  if (index === -1) {
    return { taskPath: "\\", taskName };
  }
  return {
    taskPath: `\\${taskName.slice(0, index)}\\`,
    taskName: taskName.slice(index + 1),
  };
}

export function buildRemotePowerShellScript(options = {}) {
  const mode = options.mode ?? "inventory";
  const platformTarget = options.platformTarget ?? "vem-vps";
  const machineCode = options.machineCode ?? "VEM-TESTBED-WINVM-01";
  if (!["inventory", "reset", "inventory-reset"].includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }

  const plan = assertResetPlanPreservesTestbed(buildResetPlan());
  const taskRemovals = plan.unregisterScheduledTasks
    .map((task) => {
      const { taskPath, taskName } = splitTaskName(task);
      return `Invoke-ResetStep $resetActions "unregister scheduled task ${task}" {
  $task = Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -Confirm:$false -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "scheduled task ${task} removed" {
  $null -eq (Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -ErrorAction SilentlyContinue)
}`;
    })
    .join("\n");
  const serviceStops = plan.stopServices
    .map(
      (service) => `Invoke-ResetStep $resetActions "stop service ${service}" {
  $service = Get-Service -Name ${psString(service)} -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    if ($service.Status -ne "Stopped") {
      Stop-Service -Name ${psString(service)} -Force -ErrorAction Stop
    }
    $deleteOutput = sc.exe delete ${psString(service)} 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "sc.exe delete ${service} failed ($LASTEXITCODE): $deleteOutput"
    }
  }
}
Assert-ResetPostcondition $resetActions "service ${service} removed" {
  $null -eq (Get-ServiceStateOrNull -Name ${psString(service)})
}`,
    )
    .join("\n");
  const directoryRemovals = plan.removeDirectories
    .map(
      (path) => `Invoke-ResetStep $resetActions "remove directory ${path}" {
  if (Test-Path -LiteralPath ${psString(path)}) {
    Remove-Item -LiteralPath ${psString(path)} -Recurse -Force -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "directory ${path} removed" {
  -not (Test-Path -LiteralPath ${psString(path)})
}`,
    )
    .join("\n");
  const fileRemovals = plan.removeFiles
    .map(
      (path) => `Invoke-ResetStep $resetActions "remove file ${path}" {
  if (Test-Path -LiteralPath ${psString(path)}) {
    Remove-Item -LiteralPath ${psString(path)} -Force -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "file ${path} removed" {
  -not (Test-Path -LiteralPath ${psString(path)})
}`,
    )
    .join("\n");

  return `$ErrorActionPreference = "Stop"

function Get-ServiceStateOrNull([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { return $null }
  return [pscustomobject]@{
    name = $service.Name
    status = [string]$service.Status
    startType = [string]$service.StartType
  }
}

function Test-LocalAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PathEvidence([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return [pscustomobject]@{ path = $Path; exists = $false; kind = $null }
  }
  return [pscustomobject]@{
    path = $Path
    exists = $true
    kind = if ($item.PSIsContainer) { "directory" } else { "file" }
  }
}

function Get-CommandEvidence([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  return [pscustomobject]@{
    name = $Name
    available = $null -ne $command
    source = if ($null -ne $command) { $command.Source } else { $null }
    path = if ($null -ne $command) { $command.Path } else { $null }
  }
}

function Get-LocalUserEvidence([string]$Name) {
  $user = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $user) {
    return [pscustomobject]@{ name = $Name; exists = $false; enabled = $false; admin = $false }
  }
  $admin = $false
  try {
    $admin = $null -ne (Get-LocalGroupMember -Group "Administrators" -Member $Name -ErrorAction SilentlyContinue)
  } catch {
    $admin = $false
  }
  return [pscustomobject]@{
    name = $Name
    exists = $true
    enabled = [bool]$user.Enabled
    admin = [bool]$admin
  }
}

function Get-ScheduledTaskEvidence([string]$TaskName, [string]$TaskPath) {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [pscustomobject]@{ name = "$TaskPath$TaskName"; exists = $false; state = $null; enabled = $false; runAsUser = $null }
  }
  $principal = $task.Principal
  return [pscustomobject]@{
    name = "$TaskPath$TaskName"
    exists = $true
    state = [string]$task.State
    enabled = [string]$task.State -ne "Disabled"
    runAsUser = if ($null -ne $principal) { [string]$principal.UserId } else { $null }
  }
}

function Get-WebView2Presence {
  $paths = @(
    "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application",
    "C:\\Program Files\\Microsoft\\EdgeWebView\\Application"
  )
  $existing = @($paths | Where-Object { Test-Path -LiteralPath $_ })
  return [pscustomobject]@{
    installed = $existing.Count -gt 0
    paths = $existing
  }
}

function Get-DisplayEvidence {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [pscustomobject]@{
      deviceName = $_.DeviceName
      primary = [bool]$_.Primary
      widthPx = [int]$_.Bounds.Width
      heightPx = [int]$_.Bounds.Height
    }
  })
  return [pscustomobject]@{
    source = "ssh_service_session"
    screens = $screens
  }
}

function Convert-DisplayDimensionsEvidence($Display) {
  $screen = @($Display.screens | Where-Object { $_.primary } | Select-Object -First 1)
  if ($screen.Count -eq 0) {
    $screen = @($Display.screens | Select-Object -First 1)
  }
  if ($screen.Count -eq 0) {
    return [ordered]@{
      status = "missing"
      widthPx = 0
      heightPx = 0
    }
  }
  return [ordered]@{
    status = "observed"
    widthPx = [int]$screen.widthPx
    heightPx = [int]$screen.heightPx
  }
}

function Invoke-ResetStep($Actions, [string]$Name, [scriptblock]$Script) {
  $status = "succeeded"
  $message = $null
  try {
    & $Script
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = $Name
    status = $status
    message = $message
  }) | Out-Null
}

function Assert-ResetPostcondition($Actions, [string]$Name, [scriptblock]$Condition) {
  $status = "succeeded"
  $message = $null
  try {
    if (-not (& $Condition)) {
      $status = "failed"
      $message = "postcondition failed"
    }
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = $Name
    status = $status
    message = $message
  }) | Out-Null
}

function Get-InventoryFacts {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $os = Get-CimInstance Win32_OperatingSystem
  $computer = Get-CimInstance Win32_ComputerSystem
  $hostDisplay = Get-DisplayEvidence
  $displayDimensionsEvidence = Convert-DisplayDimensionsEvidence $hostDisplay
  $daemonService = Get-ServiceStateOrNull -Name "VemVendingDaemon"
  $machineUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMachineUI" -TaskPath "\\"
  $maintenanceUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMaintenanceUI" -TaskPath "\\"
  $readyFile = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $daemonConfig = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\machine-config.json"

  return [ordered]@{
    testbedName = "win10-vem-e2e"
    collectedAt = (Get-Date).ToUniversalTime().ToString("o")
    target = [ordered]@{
      machineCode = ${psString(machineCode)}
      platformTarget = ${psString(platformTarget)}
    }
    os = [ordered]@{
      caption = [string]$os.Caption
      version = [string]$os.Version
      buildNumber = [string]$os.BuildNumber
      hostName = [string]$computer.Name
    }
    user = [ordered]@{
      current = [string]$identity.Name
      isAdmin = Test-LocalAdmin
      maintenance = Get-LocalUserEvidence "YKDZ"
      kiosk = Get-LocalUserEvidence "VEMKiosk"
    }
    access = [ordered]@{
      tailscaleCommand = Get-CommandEvidence "tailscale"
      tailscaleService = Get-ServiceStateOrNull -Name "Tailscale"
      openSshServer = Get-ServiceStateOrNull -Name "sshd"
      sshCommand = Get-CommandEvidence "ssh"
    }
    webView2 = Get-WebView2Presence
    vem = [ordered]@{
      bringupDirectory = Test-PathEvidence "C:\\VEM\\bringup"
      updatesDirectory = Test-PathEvidence "C:\\VEM\\updates"
      visionDirectory = Test-PathEvidence "C:\\VEM\\vision"
      daemonDataDirectory = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon"
      readyFile = $readyFile
      daemonConfig = $daemonConfig
      daemonService = $daemonService
      machineUiTask = $machineUiTask
      maintenanceUiTask = $maintenanceUiTask
      visionTask = Get-ScheduledTaskEvidence -TaskName "StartVisionServer" -TaskPath "\\VEM\\"
    }
    displayEvidence = [ordered]@{
      hostDisplayBaseline = $hostDisplay
      sshServiceSessionScreenDimensions = $hostDisplay
    }
    artifactConsumerPrerequisites = [ordered]@{
      powershell = $PSVersionTable.PSVersion.ToString()
      expandArchiveAvailable = $null -ne (Get-Command Expand-Archive -ErrorAction SilentlyContinue)
      getFileHashAvailable = $null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)
      scheduledTasksAvailable = $null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)
      serviceControlAvailable = $null -ne (Get-Command sc.exe -ErrorAction SilentlyContinue)
    }
    runtimeAcceptanceFactsSubset = [ordered]@{
      mode = "fresh_bring_up"
      target = [ordered]@{
        testbedName = "win10-vem-e2e"
        machineCode = ${psString(machineCode)}
        platformTarget = ${psString(platformTarget)}
      }
      displayEvidence = [ordered]@{
        hostDisplayBaseline = $displayDimensionsEvidence
        sshServiceSessionScreenDimensions = $displayDimensionsEvidence
      }
      serviceState = [ordered]@{
        daemonService = [ordered]@{
          installed = $null -ne $daemonService
          running = $null -ne $daemonService -and $daemonService.status -eq "Running"
          startupType = if ($null -ne $daemonService) { $daemonService.startType.ToLowerInvariant() } else { "unknown" }
        }
        machineUiTask = [ordered]@{
          name = "VEMMachineUI"
          exists = [bool]$machineUiTask.exists
          enabled = [bool]$machineUiTask.enabled
          runAsUser = if ([string]::IsNullOrWhiteSpace($machineUiTask.runAsUser)) { "unknown" } else { [string]$machineUiTask.runAsUser }
        }
      }
      readyFile = [ordered]@{
        exists = [bool]$readyFile.exists
        readableByKioskUser = $false
        ipcEndpointPresent = $false
        tokenPresent = $false
      }
      provisioning = [ordered]@{
        provisioned = [bool]$daemonConfig.exists
        usedDaemonIpcClaimPath = $false
      }
    }
  }
}

$mode = ${psString(mode)}
$inventoryBefore = Get-InventoryFacts
$resetPlan = [ordered]@{
  stopServices = ${psArray(plan.stopServices)}
  unregisterScheduledTasks = ${psArray(plan.unregisterScheduledTasks)}
  removeDirectories = ${psArray(plan.removeDirectories)}
  removeFiles = ${psArray(plan.removeFiles)}
  preservedResources = ${psArray(plan.preservedResources)}
}
$resetActions = [System.Collections.Generic.List[object]]::new()

if ($mode -eq "reset" -or $mode -eq "inventory-reset") {
${serviceStops}
${taskRemovals}
${fileRemovals}
${directoryRemovals}
}

$inventoryAfter = if ($mode -eq "inventory-reset") { Get-InventoryFacts } else { $null }

[pscustomobject]@{
  ok = (($resetActions | Where-Object { $_.status -eq "failed" } | Measure-Object | Select-Object -ExpandProperty Count) -eq 0)
  mode = $mode
  inventory = $inventoryBefore
  reset = [ordered]@{
    plan = $resetPlan
    actions = @($resetActions)
    idempotent = $true
  }
  inventoryAfterReset = $inventoryAfter
} | ConvertTo-Json -Depth 40
`;
}

export function buildSshCommand(options = {}) {
  const remote = options.remote ?? "YKDZ@100.68.189.11";
  const sshArgs = ["-o", "ConnectTimeout=30"];
  if (options.proxyCommand) {
    sshArgs.push("-o", `ProxyCommand=${options.proxyCommand}`);
  } else if (options.sshConfig !== true) {
    sshArgs.push("-o", "ProxyCommand=none");
  }
  if (options.identity) {
    sshArgs.push("-i", options.identity);
  }
  return ["ssh", ...sshArgs, remote];
}

function usage() {
  console.error(`Usage:
  win10-vem-e2e.mjs [--mode inventory|reset|inventory-reset] [--remote USER@HOST] [--ssh-config] [--proxy-command CMD] [--identity KEY] [--dry-run] [--out PATH]

Defaults target the documented Machine Runtime Testbed:
  --remote YKDZ@100.68.189.11
  --mode inventory
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
    } else if (arg === "--remote") {
      options.remote = next;
      index += 1;
    } else if (arg === "--identity") {
      options.identity = next;
      index += 1;
    } else if (arg === "--proxy-command") {
      options.proxyCommand = next;
      index += 1;
    } else if (arg === "--machine-code") {
      options.machineCode = next;
      index += 1;
    } else if (arg === "--platform-target") {
      options.platformTarget = next;
      index += 1;
    } else if (arg === "--out") {
      options.out = next;
      index += 1;
    } else if (arg === "--ssh-config") {
      options.sshConfig = true;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    const script = buildRemotePowerShellScript(options);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const sshCommand = buildSshCommand(options);
    const remoteCommand = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            sshCommand,
            remoteCommand,
            resetPlan: assertResetPlanPreservesTestbed(buildResetPlan()),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }

    const result = spawnSync(
      sshCommand[0],
      [...sshCommand.slice(1), remoteCommand],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.stdout && options.out) {
      writeFileSync(options.out, result.stdout, "utf8");
      console.error(`wrote report: ${options.out}`);
    } else if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
}
