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

const STARTUP_BRINGUP_EVIDENCE_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence.json";

const PLATFORM_TARGETS = {
  "vem-vps": {
    apiBaseUrl: "http://118.25.104.160:26849/api",
    mqttUrl: "mqtt://118.25.104.160:1883",
  },
};

const FINAL_PUBLIC_CONFIG_FIELDS = [
  "machineCode",
  "machineId",
  "machineName",
  "machineStatus",
  "machineLocationLabel",
  "mqttUsername",
  "mqttClientId",
  "runtimeEndpoints",
  "hardwareProfile",
  "paymentCapability",
  "provisioningMetadata",
];

export function buildBringUpPlan(options = {}) {
  return {
    setupScript:
      options.setupScript ??
      "C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1",
    requiredSecretEnvironment: [
      "VEM_KIOSK_PASSWORD",
      "VEM_MAINTENANCE_PASSWORD",
      "VEM_AUTOLOGON_PASSWORD",
    ],
    arguments: {
      KioskUser: "VEMKiosk",
      MaintenanceUser: "YKDZ",
      RunAsUser: "YKDZ",
      AutoLogonDomain: "$env:COMPUTERNAME",
      BringupDir: "C:\\VEM\\bringup",
      DaemonExe: "C:\\VEM\\bringup\\vending-daemon.exe",
      DaemonDataDir: "C:\\ProgramData\\VEM\\vending-daemon",
      DaemonReadyFile:
        "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
      StartupBringupEvidenceFile: STARTUP_BRINGUP_EVIDENCE_FILE,
      MachineUiExe: "C:\\VEM\\bringup\\machine.exe",
      MachineUiLauncher: "C:\\VEM\\bringup\\launch-machine-ui.vbs",
      MachineUiDebugLauncher: "C:\\VEM\\bringup\\launch-machine-ui-debug.vbs",
      VisionLauncher: "C:\\VEM\\bringup\\start_vision.bat",
      VisionWorkingDirectory: "C:\\VEM\\vision",
      KioskPassword: "$env:VEM_KIOSK_PASSWORD",
      MaintenancePassword: "$env:VEM_MAINTENANCE_PASSWORD",
      AutoLogonPassword: "$env:VEM_AUTOLOGON_PASSWORD",
    },
    switches: [
      "ConfigureKioskAccounts",
      "UseKioskAccount",
      "ConfigureAutoLogon",
    ],
  };
}

export function assertTestbedMachineCode(machineCode) {
  if (!String(machineCode ?? "").startsWith("VEM-TESTBED-")) {
    throw new Error(
      `machine code must be a dedicated testbed identity: ${machineCode}`,
    );
  }
  return machineCode;
}

function present(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

export function buildPreClaimPublicConfig(publicConfig = {}, platform) {
  return {
    ...publicConfig,
    machineCode: null,
    machineId: null,
    machineName: null,
    machineStatus: null,
    machineLocationLabel: null,
    apiBaseUrl: platform.apiBaseUrl,
    mqttUrl: platform.mqttUrl,
    mqttUsername: null,
    mqttClientId: null,
    runtimeEndpoints: null,
    hardwareProfile: null,
    paymentCapability: null,
    provisioningMetadata: null,
  };
}

export function evaluateFirstClaimPrecondition(configSnapshot = {}) {
  const publicConfig = configSnapshot.public ?? {};
  if (configSnapshot.provisioned === true) {
    return {
      ok: false,
      code: "already_provisioned",
      message:
        "first-claim provisioning requires reset before a provisioned config can be claimed again",
    };
  }

  const credentialFlags = [
    "machineSecretConfigured",
    "mqttSigningSecretConfigured",
    "mqttPasswordConfigured",
  ];
  const configuredCredential = credentialFlags.find(
    (field) => configSnapshot[field] === true,
  );
  if (configuredCredential) {
    return {
      ok: false,
      code: "credentials_configured",
      message: `first-claim provisioning requires reset before reusing credentialed config: ${configuredCredential}`,
    };
  }

  const staleField = FINAL_PUBLIC_CONFIG_FIELDS.find((field) =>
    present(publicConfig[field]),
  );
  if (staleField) {
    const value = publicConfig[staleField];
    const code =
      staleField === "machineCode" && !String(value).startsWith("VEM-TESTBED-")
        ? "non_testbed_identity"
        : "stale_final_identity";
    return {
      ok: false,
      code,
      message: `first-claim provisioning requires reset before reusing final config field: ${staleField}`,
    };
  }

  return { ok: true, code: "ready_for_first_claim", message: null };
}

export function classifyProvisioningFailure(errorInfo = {}) {
  if (present(errorInfo.body?.code)) {
    return String(errorInfo.body.code);
  }
  if (Number.isInteger(errorInfo.statusCode)) {
    return `http_${errorInfo.statusCode}`;
  }
  return "request_failed";
}

export function buildReadyFileEvidence(readyFile) {
  if (!readyFile) {
    return {
      exists: false,
      ipcEndpointPresent: false,
      tokenPresent: false,
      error: "ready_file_missing",
    };
  }

  const tokenPresent = present(readyFile.ipcToken);
  const healthzUrl = String(readyFile.healthzUrl ?? "");
  const ipcEndpointPresent = healthzUrl.trim().length > 0;
  let error = null;
  if (!tokenPresent) {
    error = "ipc_token_missing";
  } else if (!ipcEndpointPresent) {
    error = "healthz_url_missing";
  } else if (!healthzUrl.endsWith("/healthz")) {
    error = "healthz_url_invalid";
  }

  return {
    exists: true,
    ipcEndpointPresent,
    tokenPresent,
    error,
  };
}

export function buildProvisioningFacts({ configSnapshot, actions = [] } = {}) {
  const actionList = Array.isArray(actions) ? actions : [];
  const usedDaemonIpcClaimPath = actionList.some((action) => {
    const evidence = action?.evidence ?? {};
    return (
      evidence.usedDaemonIpcClaimPath === true &&
      String(evidence.endpoint ?? "").endsWith("/v1/provisioning/claim") &&
      ["provisioned", "failed"].includes(String(evidence.claimStatus ?? ""))
    );
  });
  return {
    provisioned: configSnapshot?.provisioned === true,
    usedDaemonIpcClaimPath,
    machineCode: configSnapshot?.public?.machineCode ?? null,
    machineSecretConfigured: configSnapshot?.machineSecretConfigured === true,
    mqttSigningSecretConfigured:
      configSnapshot?.mqttSigningSecretConfigured === true,
    mqttPasswordConfigured: configSnapshot?.mqttPasswordConfigured === true,
    provisioningIssues: Array.isArray(configSnapshot?.provisioningIssues)
      ? configSnapshot.provisioningIssues.map(String)
      : [],
  };
}

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

function psArgumentValue(value) {
  if (String(value).startsWith("$env:")) {
    return String(value);
  }
  return psString(value);
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
  const supportedModes = [
    "inventory",
    "reset",
    "inventory-reset",
    "bring-up",
    "provision",
  ];
  if (!supportedModes.includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  assertTestbedMachineCode(machineCode);
  if (
    mode === "provision" &&
    !Object.hasOwn(PLATFORM_TARGETS, platformTarget)
  ) {
    throw new Error(`unsupported platform target: ${platformTarget}`);
  }
  const platform =
    PLATFORM_TARGETS[platformTarget] ?? PLATFORM_TARGETS["vem-vps"];
  const claimCode = options.claimCode ?? "";
  if (mode === "provision" && String(claimCode).trim().length === 0) {
    throw new Error("provision mode requires --claim-code");
  }

  const plan = assertResetPlanPreservesTestbed(buildResetPlan());
  const bringUpPlan = buildBringUpPlan(options);
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
  const bringUpArgumentLines = Object.entries(bringUpPlan.arguments)
    .map(([name, value]) => `    ${psString(name)} = ${psArgumentValue(value)}`)
    .join("\n");
  const bringUpReportArgumentLines = Object.entries(bringUpPlan.arguments)
    .map(([name, value]) => {
      const reportValue = String(value).startsWith("$env:")
        ? `<${String(value).slice(1)}>`
        : String(value);
      return `        ${psString(name)} = ${psString(reportValue)}`;
    })
    .join("\n");
  const bringUpSwitchLines = bringUpPlan.switches
    .map((name) => `  $setupArgs[${psString(name)}] = $true`)
    .join("\n");

  return `$ErrorActionPreference = "Stop"

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "file not found: $Path"
  }
  return [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
}

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

function Assert-RequiredSecretEnvironment([string]$Name) {
  if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Name, "Process"))) {
    throw "required secret environment variable is missing: $Name"
  }
}

function Invoke-ProductionBringUp($Actions) {
  $status = "succeeded"
  $message = $null
  $output = @()
  try {
    foreach ($secretName in ${psArray(bringUpPlan.requiredSecretEnvironment)}) {
      Assert-RequiredSecretEnvironment $secretName
    }
    $setupScript = ${psString(bringUpPlan.setupScript)}
    if (-not (Test-Path -LiteralPath $setupScript)) {
      throw "production bring-up script not found: $setupScript"
    }
    $setupArgs = @{
${bringUpArgumentLines}
    }
${bringUpSwitchLines}
    $output = @(& $setupScript @setupArgs *>&1 | ForEach-Object { [string]$_ })
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = "run production bring-up"
    status = $status
    message = $message
    setupScript = ${psString(bringUpPlan.setupScript)}
    output = $output
  }) | Out-Null
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

function Get-IpcBaseUrl($Ready) {
  $healthz = [string]$Ready.healthzUrl
  if ([string]::IsNullOrWhiteSpace($healthz)) {
    throw "healthzUrl missing from daemon ready file"
  }
  if (-not $healthz.EndsWith("/healthz", [StringComparison]::OrdinalIgnoreCase)) {
    throw "invalid healthzUrl in daemon ready file: $healthz"
  }
  return $healthz.Substring(0, $healthz.Length - "/healthz".Length)
}

function Get-HttpErrorInfo($ErrorRecord) {
  $statusCode = $null
  $bodyText = ""
  $response = $ErrorRecord.Exception.Response

  if ($null -ne $response) {
    if ($null -ne $response.StatusCode) {
      $statusCode = [int]$response.StatusCode
    }
    if ($null -ne $response.Content) {
      try {
        $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } catch {
        $bodyText = ""
      }
    } elseif ($response.PSObject.Methods.Name -contains "GetResponseStream") {
      try {
        $stream = $response.GetResponseStream()
        if ($null -ne $stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $bodyText = $reader.ReadToEnd()
        }
      } catch {
        $bodyText = ""
      }
    }
  }

  if ($bodyText.Length -eq 0 -and $null -ne $ErrorRecord.ErrorDetails -and $null -ne $ErrorRecord.ErrorDetails.Message) {
    $bodyText = $ErrorRecord.ErrorDetails.Message
  }

  $body = $null
  if ($bodyText.Length -gt 0) {
    try {
      $body = $bodyText | ConvertFrom-Json -ErrorAction Stop
    } catch {
      $body = $null
    }
  }

  [pscustomobject]@{
    statusCode = $statusCode
    bodyText = $bodyText
    body = $body
  }
}

function Invoke-IpcJson([string]$Method, [string]$Uri, $Headers, $Body = $null) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec 20
  }
  $json = $Body | ConvertTo-Json -Depth 40 -Compress
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ContentType "application/json" -Body $json -TimeoutSec 60
}

function Convert-ClaimFailureClassification($ErrorInfo) {
  if ($null -ne $ErrorInfo.body -and -not [string]::IsNullOrWhiteSpace($ErrorInfo.body.code)) {
    return [string]$ErrorInfo.body.code
  }
  if ($null -ne $ErrorInfo.statusCode) {
    return "http_$($ErrorInfo.statusCode)"
  }
  return "request_failed"
}

function Test-ConfigFieldPresent($Object, [string]$Name) {
  if ($null -eq $Object) { return $false }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $false }
  $value = $property.Value
  if ($null -eq $value) { return $false }
  if ($value -is [string]) {
    return -not [string]::IsNullOrWhiteSpace($value)
  }
  return $true
}

function Assert-FirstClaimConfig($Config) {
  if ([bool]$Config.provisioned) {
    throw "first-claim provisioning requires reset before reusing provisioned config"
  }

  foreach ($field in @("machineSecretConfigured", "mqttSigningSecretConfigured", "mqttPasswordConfigured")) {
    $property = $Config.PSObject.Properties[$field]
    if ($null -ne $property -and [bool]$property.Value) {
      throw "first-claim provisioning requires reset before reusing credentialed config: $field"
    }
  }

  $public = $Config.public
  if ($null -eq $public) {
    throw "daemon config response missing public config"
  }
  foreach ($field in @(
    "machineCode",
    "machineId",
    "machineName",
    "machineStatus",
    "machineLocationLabel",
    "mqttUsername",
    "mqttClientId",
    "runtimeEndpoints",
    "hardwareProfile",
    "paymentCapability",
    "provisioningMetadata"
  )) {
    if (Test-ConfigFieldPresent $public $field) {
      if ($field -eq "machineCode" -and -not ([string]$public.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
        throw "refusing to provision over non-testbed configured identity: $($public.machineCode)"
      }
      throw "first-claim provisioning requires reset before reusing final config field: $field"
    }
  }
}

function New-PreClaimPublicConfig($Public) {
  return [ordered]@{
    machineCode = $null
    machineId = $null
    machineName = $null
    machineStatus = $null
    machineLocationLabel = $null
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    mqttUsername = $null
    mqttClientId = $null
    hardwareAdapter = $Public.hardwareAdapter
    serialPortPath = $Public.serialPortPath
    lowerControllerUsbIdentity = $Public.lowerControllerUsbIdentity
    scannerAdapter = $Public.scannerAdapter
    scannerSerialPortPath = $Public.scannerSerialPortPath
    scannerUsbIdentity = $Public.scannerUsbIdentity
    scannerBaudRate = $Public.scannerBaudRate
    scannerFrameSuffix = $Public.scannerFrameSuffix
    visionEnabled = $Public.visionEnabled
    visionWsUrl = $Public.visionWsUrl
    visionRequestTimeoutMs = $Public.visionRequestTimeoutMs
    machineAudioVolume = $Public.machineAudioVolume
    audioCueSettings = $Public.audioCueSettings
    kioskMode = $Public.kioskMode
    stockMovementRetentionDays = $Public.stockMovementRetentionDays
    runtimeEndpoints = $null
    hardwareProfile = $null
    paymentCapability = $null
    provisioningMetadata = $null
  }
}

function Convert-ConfigSnapshotEvidence($Config) {
  if ($null -eq $Config) {
    return [ordered]@{
      observed = $false
      provisioned = $false
      machineCode = $null
      machineSecretConfigured = $false
      mqttSigningSecretConfigured = $false
      mqttPasswordConfigured = $false
      provisioningIssues = @()
      error = $null
    }
  }
  return [ordered]@{
    observed = $true
    provisioned = [bool]$Config.provisioned
    machineCode = if ($null -ne $Config.public) { $Config.public.machineCode } else { $null }
    machineSecretConfigured = [bool]$Config.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$Config.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$Config.mqttPasswordConfigured
    provisioningIssues = @($Config.provisioningIssues | ForEach-Object { [string]$_ })
    error = $null
  }
}

function Convert-HealthzEvidence($Snapshot) {
  return [ordered]@{
    observed = $true
    status = if ($null -ne $Snapshot.status) { [string]$Snapshot.status } else { $null }
    operatorReason = if ($null -ne $Snapshot.operatorReason) { [string]$Snapshot.operatorReason } else { $null }
    hardwareOnline = [bool]$Snapshot.hardwareOnline
    scannerOnline = [bool]$Snapshot.scannerOnline
    backendOnline = [bool]$Snapshot.backendOnline
    mqttConnected = [bool]$Snapshot.mqttConnected
    error = $null
  }
}

function Convert-ReadyzEvidence($Snapshot) {
  return [ordered]@{
    observed = $true
    ready = [bool]$Snapshot.ready
    canSell = [bool]$Snapshot.canSell
    mode = if ($null -ne $Snapshot.mode) { [string]$Snapshot.mode } else { $null }
    suggestedRoute = if ($null -ne $Snapshot.suggestedRoute) { [string]$Snapshot.suggestedRoute } else { $null }
    blockingCodes = @($Snapshot.blockingCodes | ForEach-Object { [string]$_ })
    error = $null
  }
}

function Get-FailedIpcEvidence($ErrorRecord) {
  $errorInfo = Get-HttpErrorInfo $ErrorRecord
  return [ordered]@{
    observed = $false
    statusCode = $errorInfo.statusCode
    error = Convert-ClaimFailureClassification $errorInfo
  }
}

function Get-SafeHealthzEvidence([string]$BaseUrl) {
  try {
    return Convert-HealthzEvidence (Invoke-IpcJson "GET" "$BaseUrl/healthz" @{})
  } catch {
    return Get-FailedIpcEvidence $_
  }
}

function Get-SafeReadyzEvidence([string]$BaseUrl) {
  try {
    return Convert-ReadyzEvidence (Invoke-IpcJson "GET" "$BaseUrl/readyz" @{})
  } catch {
    return Get-FailedIpcEvidence $_
  }
}

function Get-DaemonIpcInventoryEvidence([string]$ReadyFilePath) {
  $evidence = [ordered]@{
    readyFile = [ordered]@{
      exists = $false
      readableByKioskUser = $false
      ipcEndpointPresent = $false
      tokenPresent = $false
      error = $null
    }
    config = Convert-ConfigSnapshotEvidence $null
    healthz = [ordered]@{ observed = $false; error = $null }
    readyz = [ordered]@{ observed = $false; error = $null }
  }

  if (-not (Test-Path -LiteralPath $ReadyFilePath)) {
    $evidence.readyFile.error = "ready_file_missing"
    return $evidence
  }
  $evidence.readyFile.exists = $true

  try {
    $ready = Read-JsonFile $ReadyFilePath
    $evidence.readyFile.tokenPresent = -not [string]::IsNullOrWhiteSpace($ready.ipcToken)
    $evidence.readyFile.ipcEndpointPresent = -not [string]::IsNullOrWhiteSpace($ready.healthzUrl)
    $baseUrl = Get-IpcBaseUrl $ready
    $evidence.healthz = Get-SafeHealthzEvidence $baseUrl
    $evidence.readyz = Get-SafeReadyzEvidence $baseUrl
    if (-not $evidence.readyFile.tokenPresent) {
      $evidence.config.error = "ipc_token_missing"
      return $evidence
    }
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    try {
      $evidence.config = Convert-ConfigSnapshotEvidence (Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers)
    } catch {
      $failed = Get-FailedIpcEvidence $_
      $evidence.config.error = $failed.error
    }
  } catch {
    $evidence.readyFile.error = [string]$_
  }

  return $evidence
}

function Convert-ProvisioningFacts($DaemonIpc, $ProvisioningActions) {
  $usedClaimPath = $false
  foreach ($action in @($ProvisioningActions)) {
    $actionEvidence = $action.evidence
    if (
      $null -ne $actionEvidence -and
      [bool]$actionEvidence.usedDaemonIpcClaimPath -and
      ([string]$actionEvidence.endpoint).EndsWith("/v1/provisioning/claim", [StringComparison]::OrdinalIgnoreCase) -and
      @("provisioned", "failed") -contains [string]$actionEvidence.claimStatus
    ) {
      $usedClaimPath = $true
    }
  }

  return [ordered]@{
    provisioned = [bool]$DaemonIpc.config.provisioned
    usedDaemonIpcClaimPath = $usedClaimPath
    machineCode = $DaemonIpc.config.machineCode
    machineSecretConfigured = [bool]$DaemonIpc.config.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$DaemonIpc.config.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$DaemonIpc.config.mqttPasswordConfigured
    provisioningIssues = @($DaemonIpc.config.provisioningIssues | ForEach-Object { [string]$_ })
  }
}

function Invoke-TestbedProvisioningClaim($Actions) {
  $status = "succeeded"
  $message = $null
  $evidence = [ordered]@{
    usedDaemonIpcClaimPath = $false
    readyFile = ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    endpoint = $null
    expectedMachineCode = ${psString(machineCode)}
    platformTarget = ${psString(platformTarget)}
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    preClaimConfigApplied = $false
    claimStatus = "not_attempted"
    claimFailureCode = $null
    claimHttpStatus = $null
    claimResult = [ordered]@{
      restartRequested = $null
    }
    machineCode = $null
    provisioned = $false
    credentialFlags = [ordered]@{
      machineSecretConfigured = $false
      mqttSigningSecretConfigured = $false
      mqttPasswordConfigured = $false
    }
    provisioningIssues = @()
    healthzAfterClaim = [ordered]@{ observed = $false; error = $null }
    readyzAfterClaim = [ordered]@{ observed = $false; error = $null }
  }

  try {
    if (-not ${psString(machineCode)}.StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
      throw "refusing to provision non-testbed target identity: ${machineCode}"
    }

    $ready = Read-JsonFile ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    if ([string]::IsNullOrWhiteSpace($ready.ipcToken)) {
      throw "ipcToken missing from daemon ready file"
    }
    $baseUrl = Get-IpcBaseUrl $ready
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }

    $configBefore = Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers
    $public = $configBefore.public
    Assert-FirstClaimConfig $configBefore

    $public = New-PreClaimPublicConfig $public
    $configPayload = [ordered]@{
      public = $public
      secrets = $null
    }
    $configBeforeClaim = Invoke-IpcJson "PUT" "$baseUrl/v1/config" $headers $configPayload
    $evidence.preClaimConfigApplied = $true

    $claimPayload = [ordered]@{ claimCode = ${psString(claimCode)} }
    $evidence.endpoint = "$baseUrl/v1/provisioning/claim"
    $evidence.usedDaemonIpcClaimPath = $true
    try {
      $claimResult = Invoke-IpcJson "POST" "$baseUrl/v1/provisioning/claim" $headers $claimPayload
      $evidence.claimStatus = "provisioned"
      $evidence.machineCode = $claimResult.machineCode
      $evidence.claimResult.restartRequested = if ($null -ne $claimResult.restartRequested) { [bool]$claimResult.restartRequested } else { $null }
    } catch {
      $claimError = Get-HttpErrorInfo $_
      $evidence.claimStatus = "failed"
      $evidence.claimFailureCode = Convert-ClaimFailureClassification $claimError
      $evidence.claimHttpStatus = $claimError.statusCode
      throw "daemon IPC claim failed: $($evidence.claimFailureCode)"
    }

    $evidence.healthzAfterClaim = Get-SafeHealthzEvidence $baseUrl
    $evidence.readyzAfterClaim = Get-SafeReadyzEvidence $baseUrl
    $configAfter = Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers
    $configEvidence = Convert-ConfigSnapshotEvidence $configAfter
    $evidence.provisioned = $configEvidence.provisioned
    $evidence.credentialFlags.machineSecretConfigured = $configEvidence.machineSecretConfigured
    $evidence.credentialFlags.mqttSigningSecretConfigured = $configEvidence.mqttSigningSecretConfigured
    $evidence.credentialFlags.mqttPasswordConfigured = $configEvidence.mqttPasswordConfigured
    $evidence.provisioningIssues = $configEvidence.provisioningIssues
    if ([string]::IsNullOrWhiteSpace($evidence.machineCode)) {
      $evidence.machineCode = $configEvidence.machineCode
    }
    if (-not ([string]$evidence.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
      throw "daemon IPC claim returned non-testbed identity: $($evidence.machineCode)"
    }
    if ([string]$evidence.machineCode -ne ${psString(machineCode)}) {
      throw "daemon IPC claim returned unexpected testbed identity: $($evidence.machineCode)"
    }
    if (-not $evidence.provisioned) {
      throw "daemon IPC claim completed but daemon config is not provisioned"
    }
  } catch {
    $status = "failed"
    $message = [string]$_
  }

  $Actions.Add([pscustomobject]@{
    name = "daemon IPC provisioning claim"
    status = $status
    message = $message
    evidence = $evidence
  }) | Out-Null
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
    return [pscustomobject]@{
      name = "$TaskPath$TaskName"
      exists = $false
      state = $null
      enabled = $false
      runAsUser = $null
      command = $null
      arguments = $null
      workingDirectory = $null
    }
  }
  $principal = $task.Principal
  $action = @($task.Actions | Select-Object -First 1)
  return [pscustomobject]@{
    name = "$TaskPath$TaskName"
    exists = $true
    state = [string]$task.State
    enabled = [string]$task.State -ne "Disabled"
    runAsUser = if ($null -ne $principal) { [string]$principal.UserId } else { $null }
    command = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }
    arguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }
    workingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null }
  }
}

function Get-WinlogonAutoLogonEvidence {
  $winlogon = Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" -ErrorAction SilentlyContinue
  if ($null -eq $winlogon) {
    return [ordered]@{
      configured = $false
      user = "unknown"
      domain = "unknown"
      force = $false
    }
  }
  return [ordered]@{
    configured = [string]$winlogon.AutoAdminLogon -eq "1"
    user = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultUserName)) { "unknown" } else { [string]$winlogon.DefaultUserName }
    domain = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultDomainName)) { "unknown" } else { [string]$winlogon.DefaultDomainName }
    force = [string]$winlogon.ForceAutoLogon -eq "1"
  }
}

function Get-MachineUiStartupEvidence($MachineUiTask) {
  $task = Get-ScheduledTask -TaskName "VEMMachineUI" -TaskPath "\\" -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [ordered]@{
      configured = $false
      mode = "scheduled_task"
      runAsUser = "unknown"
      command = "unknown"
    }
  }
  $action = @($task.Actions | Select-Object -First 1)
  return [ordered]@{
    configured = [bool]$MachineUiTask.exists -and [bool]$MachineUiTask.enabled
    mode = "scheduled_task"
    runAsUser = if ([string]::IsNullOrWhiteSpace($MachineUiTask.runAsUser)) { "unknown" } else { [string]$MachineUiTask.runAsUser }
    command = if ($action.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($action[0].Execute)) { [string]$action[0].Execute } else { "unknown" }
  }
}

function Convert-StartupCommandEvidence($Command) {
  return [ordered]@{
    name = if ([string]::IsNullOrWhiteSpace($Command.name)) { "unknown" } else { [string]$Command.name }
    exists = [bool]$Command.exists
    enabled = [bool]$Command.enabled
    runAsUser = if ([string]::IsNullOrWhiteSpace($Command.runAsUser)) { $null } else { [string]$Command.runAsUser }
    command = if ([string]::IsNullOrWhiteSpace($Command.command)) { $null } else { [string]$Command.command }
    arguments = if ([string]::IsNullOrWhiteSpace($Command.arguments)) { $null } else { [string]$Command.arguments }
    workingDirectory = if ([string]::IsNullOrWhiteSpace($Command.workingDirectory)) { $null } else { [string]$Command.workingDirectory }
  }
}

function Get-MissingStartupBringupEvidence {
  return [ordered]@{
    configuredBy = "missing"
    productionBringup = $false
    daemonOwnedInitialization = $true
    autoLogon = [ordered]@{
      configured = $false
      user = "unknown"
      domain = "unknown"
      force = $false
    }
    machineUiStartup = [ordered]@{
      configured = $false
      mode = "scheduled_task"
      runAsUser = "unknown"
      command = "unknown"
    }
    startupCommands = @()
  }
}

function Get-StartupBringupEvidence {
  $path = ${psString(STARTUP_BRINGUP_EVIDENCE_FILE)}
  if (-not (Test-Path -LiteralPath $path)) {
    return Get-MissingStartupBringupEvidence
  }

  $evidence = Read-JsonFile $path
  $startupCommands = @($evidence.startupCommands | ForEach-Object {
    Convert-StartupCommandEvidence $_
  })
  return [ordered]@{
    configuredBy = if ([string]::IsNullOrWhiteSpace($evidence.configuredBy)) { "unknown" } else { [string]$evidence.configuredBy }
    productionBringup = [bool]$evidence.productionBringup
    daemonOwnedInitialization = [bool]$evidence.daemonOwnedInitialization
    autoLogon = [ordered]@{
      configured = [bool]$evidence.autoLogon.configured
      user = if ([string]::IsNullOrWhiteSpace($evidence.autoLogon.user)) { "unknown" } else { [string]$evidence.autoLogon.user }
      domain = if ([string]::IsNullOrWhiteSpace($evidence.autoLogon.domain)) { "unknown" } else { [string]$evidence.autoLogon.domain }
      force = [bool]$evidence.autoLogon.force
    }
    machineUiStartup = [ordered]@{
      configured = [bool]$evidence.machineUiStartup.configured
      mode = if ([string]$evidence.machineUiStartup.mode -eq "shell_launcher") { "shell_launcher" } else { "scheduled_task" }
      runAsUser = if ([string]::IsNullOrWhiteSpace($evidence.machineUiStartup.runAsUser)) { "unknown" } else { [string]$evidence.machineUiStartup.runAsUser }
      command = if ([string]::IsNullOrWhiteSpace($evidence.machineUiStartup.command)) { "unknown" } else { [string]$evidence.machineUiStartup.command }
    }
    startupCommands = $startupCommands
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

function Get-InventoryFacts($ProvisioningActions = @()) {
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
  $startupBringup = Get-StartupBringupEvidence
  $daemonIpc = Get-DaemonIpcInventoryEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $provisioningFacts = Convert-ProvisioningFacts $daemonIpc $ProvisioningActions

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
      startupBringup = $startupBringup
      readyFile = $daemonIpc.readyFile
      provisioning = $provisioningFacts
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
$bringUpActions = [System.Collections.Generic.List[object]]::new()
$provisioningActions = [System.Collections.Generic.List[object]]::new()

if ($mode -eq "reset" -or $mode -eq "inventory-reset") {
${serviceStops}
${taskRemovals}
${fileRemovals}
${directoryRemovals}
}

if ($mode -eq "bring-up") {
  Invoke-ProductionBringUp $bringUpActions
}

if ($mode -eq "provision") {
  Invoke-TestbedProvisioningClaim $provisioningActions
}

$inventoryAfter = if ($mode -eq "inventory-reset") { Get-InventoryFacts } else { $null }
$inventoryAfterBringUp = if ($mode -eq "bring-up") { Get-InventoryFacts } else { $null }
$inventoryAfterProvision = if ($mode -eq "provision") { Get-InventoryFacts $provisioningActions } else { $null }

[pscustomobject]@{
  ok = (((@($resetActions) + @($bringUpActions) + @($provisioningActions)) | Where-Object { $_.status -eq "failed" } | Measure-Object | Select-Object -ExpandProperty Count) -eq 0)
  mode = $mode
  inventory = $inventoryBefore
  reset = [ordered]@{
    plan = $resetPlan
    actions = @($resetActions)
    idempotent = $true
  }
  bringUp = [ordered]@{
    plan = [ordered]@{
      setupScript = ${psString(bringUpPlan.setupScript)}
      requiredSecretEnvironment = ${psArray(bringUpPlan.requiredSecretEnvironment)}
      arguments = [ordered]@{
${bringUpReportArgumentLines}
      }
      switches = ${psArray(bringUpPlan.switches)}
    }
    actions = @($bringUpActions)
  }
  provisioning = [ordered]@{
    actions = @($provisioningActions)
  }
  inventoryAfterReset = $inventoryAfter
  inventoryAfterBringUp = $inventoryAfterBringUp
  inventoryAfterProvision = $inventoryAfterProvision
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
  win10-vem-e2e.mjs [--mode inventory|reset|inventory-reset|bring-up|provision] [--claim-code CODE] [--remote USER@HOST] [--ssh-config] [--proxy-command CMD] [--identity KEY] [--dry-run] [--out PATH]

Defaults target the documented Machine Runtime Testbed:
  --remote YKDZ@100.68.189.11
  --mode inventory

Bring-up mode invokes C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1 on the remote host and requires VEM_KIOSK_PASSWORD, VEM_MAINTENANCE_PASSWORD, and VEM_AUTOLOGON_PASSWORD in the remote PowerShell environment.

Provision mode reads the daemon ready file, applies only pre-claim platform endpoints, and claims the prepared testbed identity through daemon IPC /v1/provisioning/claim.
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
    } else if (arg === "--claim-code") {
      options.claimCode = next;
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
            bringUpPlan: buildBringUpPlan(options),
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
