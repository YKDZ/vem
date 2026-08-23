#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDaemonFulfillmentStoreCheckpointScript } from "./delayed-pickup-daemon-evidence.ts";
import { startDelayedPickupLiveProductionTrack } from "./delayed-pickup-live-production-track.ts";
import {
  collectDelayedPickupProductionEvidence,
  verifyDelayedPickupNativeAudioProductionEvidence,
} from "./delayed-pickup-native-audio-acceptance.ts";
import {
  routeFromTauriUrl,
  runVisibleMachineSaleScenario,
} from "./machine-ui-cdp-driver.ts";
import {
  buildAcceptanceScriptCommand,
  buildInstalledKioskSaleCleanupScript,
  buildInstalledKioskSaleLaunchScript,
  captureInstalledKioskSaleHook,
  runInstalledKioskSaleRemoteScript,
} from "./win10-vem-e2e.ts";

const SCHEMA_VERSION = "installed-kiosk-sale-acceptance/v2";
const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";
const PROFILE_NAMES = new Set([
  "vm-normal",
  "vm-scanner-payment-code",
  "vm-route-competition",
  "vm-ipc-recovery",
  "vm-delayed-pickup-native-audio",
]);
const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";

type JsonRecord = Record<string, unknown>;

interface InstalledKioskSaleCliOptions {
  run_id: string;
  machine_code: string;
  platform_target: string;
  ephemeral_platform_evidence: string;
  runtime_acceptance_report: string;
  identity: string;
  certificate: string;
  adapter: string;
  target_identity: string;
  runtime_base: string;
  out: string;
  profile: string;
  already_claimed?: boolean;
  dry_run?: boolean;
  lifecycle_reference?: string;
  remote?: string;
  ssh_port?: number;
  ssh_known_hosts_path?: string;
  ssh_host_key_alias?: string;
  runtime_guest_endpoint_json?: string;
  expected_testbed_user?: string;
  scanner_code_file?: string;
  [key: string]: unknown;
}

interface InstalledKioskRuntimeBinding {
  normalTargetId: string | null;
  sessionUser: string;
  sessionId: number;
  route: string;
  url: unknown;
  productionCdpDisabled: boolean;
  [key: string]: unknown;
}

interface InstalledKioskRunnerTrust {
  signingKeyFile: string;
  signingKeyPem: Buffer | string;
  publicKey: string;
}

interface InstalledKioskSaleReport extends JsonRecord {
  schemaVersion: string;
  kind: string;
  status: string;
  ok: boolean;
  runId: string;
  profile: string;
  evidence: JsonRecord;
}

interface InstalledKioskCaptureInput {
  options: JsonRecord;
  attestation: JsonRecord;
  selector: string;
  route: string | RegExp;
}

type InstalledKioskRunCommand = (
  command: string[],
  label: string,
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<JsonRecord>;
type InstalledKioskRunRemote = (
  options: JsonRecord,
  script: string,
) => JsonRecord;
type InstalledKioskCapture = (
  input: InstalledKioskCaptureInput,
) => Promise<JsonRecord>;

interface InstalledKioskSaleDependencies {
  runCommand?: InstalledKioskRunCommand;
  runRemote?: InstalledKioskRunRemote;
  drive?: (options: JsonRecord) => Promise<unknown>;
  capture?: InstalledKioskCapture;
}

function required(options: JsonRecord, name: string): string {
  const value = options[name.replaceAll("-", "_")];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function parseArgs(argv: string[]): JsonRecord {
  const options: JsonRecord = {};
  const stringOptions = new Set([
    "run-id",
    "machine-code",
    "platform-target",
    "ephemeral-platform-evidence",
    "runtime-acceptance-report",
    "remote",
    "ssh-port",
    "ssh-known-hosts-path",
    "ssh-host-key-alias",
    "expected-testbed-user",
    "identity",
    "certificate",
    "runtime-guest-endpoint-json",
    "adapter",
    "target-identity",
    "runtime-base",
    "scanner-code-file",
    "lifecycle-reference",
    "profile",
    "out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--already-claimed") {
      options.already_claimed = true;
      continue;
    }
    if (!stringOptions.has(arg.slice(2))) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    options[arg.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  for (const name of [
    "run_id",
    "machine_code",
    "platform_target",
    "ephemeral_platform_evidence",
    "runtime_acceptance_report",
    "identity",
    "certificate",
    "adapter",
    "target_identity",
    "runtime_base",
    "out",
  ]) {
    required(options, name.replaceAll("_", "-"));
  }
  if (options.profile == null) options.profile = "vm-normal";
  if (!PROFILE_NAMES.has(String(options.profile))) {
    throw new Error(
      "--profile must be vm-normal, vm-scanner-payment-code, vm-route-competition, vm-ipc-recovery, or vm-delayed-pickup-native-audio",
    );
  }
  if (options.ssh_port != null) {
    options.ssh_port = Number(options.ssh_port);
    if (
      !Number.isInteger(options.ssh_port) ||
      (options.ssh_port as number) < 1
    ) {
      throw new Error("--ssh-port must be a positive integer");
    }
  }
  return options;
}

function installedKioskSaleCliOptions(
  options: JsonRecord,
): InstalledKioskSaleCliOptions {
  const optionalString = (name: string): string | undefined => {
    const value = options[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    run_id: required(options, "run-id"),
    machine_code: required(options, "machine-code"),
    platform_target: required(options, "platform-target"),
    ephemeral_platform_evidence: required(
      options,
      "ephemeral-platform-evidence",
    ),
    runtime_acceptance_report: required(
      options,
      "runtime-acceptance-report",
    ),
    identity: required(options, "identity"),
    certificate: required(options, "certificate"),
    adapter: required(options, "adapter"),
    target_identity: required(options, "target-identity"),
    runtime_base: required(options, "runtime-base"),
    out: required(options, "out"),
    profile: String(options.profile ?? "vm-normal"),
    already_claimed: options.already_claimed === true,
    dry_run: options.dry_run === true,
    lifecycle_reference: optionalString("lifecycle_reference"),
    remote: optionalString("remote"),
    ssh_port: typeof options.ssh_port === "number" ? options.ssh_port : undefined,
    ssh_known_hosts_path: optionalString("ssh_known_hosts_path"),
    ssh_host_key_alias: optionalString("ssh_host_key_alias"),
    runtime_guest_endpoint_json: optionalString("runtime_guest_endpoint_json"),
    expected_testbed_user: optionalString("expected_testbed_user"),
    scanner_code_file: optionalString("scanner_code_file"),
  };
}

function readRuntimeBinding(path: string): InstalledKioskRuntimeBinding {
  const report = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
  const runtime = report?.runtimeAcceptanceReport as JsonRecord | undefined;
  const kiosk = runtime?.kioskRuntime as JsonRecord | undefined;
  const cdpRoute =
    typeof kiosk?.url === "string" &&
    kiosk.url.startsWith("http://tauri.localhost/#/");
  const productionNormalUi =
    kiosk?.source === "webview2_process" &&
    kiosk?.cdpAvailable === false &&
    kiosk?.url === "unavailable:production-cdp-disabled" &&
    kiosk?.machineProcessCount === 1 &&
    kiosk?.machineExecutablePath === "C:\\VEM\\bringup\\machine.exe" &&
    (kiosk?.webView2ProcessCount as number) >= 1;
  if (
    report?.ok !== true ||
    runtime?.schemaVersion !== "runtime-acceptance-report/v1" ||
    typeof kiosk?.sessionUser !== "string" ||
    kiosk.sessionUser.trim() !== kiosk.sessionUser ||
    kiosk.sessionUser.length === 0 ||
    !Number.isInteger(kiosk?.sessionId) ||
    (kiosk.sessionId as number) < 1 ||
    (!cdpRoute && !productionNormalUi)
  ) {
    throw new Error(
      "runtime acceptance report must prove an active interactive session",
    );
  }
  return {
    normalTargetId:
      cdpRoute && typeof kiosk.cdpTargetId === "string" && kiosk.cdpTargetId
        ? (kiosk.cdpTargetId as string)
        : null,
    sessionUser: kiosk.sessionUser as string,
    sessionId: kiosk.sessionId as number,
    route: cdpRoute ? routeFromTauriUrl(kiosk.url) : "#/catalog",
    url: kiosk.url,
    productionCdpDisabled: productionNormalUi,
  };
}

function resolveRemoteOptions(options: JsonRecord): JsonRecord {
  const remote = options.remote;
  const endpointJson = options.runtime_guest_endpoint_json;
  if (remote && endpointJson) {
    throw new Error(
      "--remote and --runtime-guest-endpoint-json are mutually exclusive",
    );
  }
  if (remote) {
    return {
      remote: String(remote),
      sshPort: options.ssh_port as number | undefined,
    };
  }
  let endpoint;
  try {
    endpoint = JSON.parse(
      required(options, "runtime-guest-endpoint-json"),
    ) as JsonRecord;
  } catch {
    throw new Error(
      "--runtime-guest-endpoint-json must contain a discovered SSH endpoint",
    );
  }
  if (
    endpoint?.protocol !== "ssh" ||
    typeof endpoint.host !== "string" ||
    !Number.isInteger(endpoint.port) ||
    !options.expected_testbed_user
  ) {
    throw new Error(
      "runtime guest endpoint requires protocol, host, port, and --expected-testbed-user",
    );
  }
  return {
    remote: `${String(options.expected_testbed_user)}@${String(endpoint.host)}`,
    sshPort: endpoint.port as number,
    sshHostKeyAlias:
      (options.ssh_host_key_alias as string | undefined) ??
      `vem-installed-kiosk-${String(options.run_id).toLowerCase()}`,
  };
}

function executionOptions(options: JsonRecord): JsonRecord {
  return {
    runId: options.run_id,
    machineCode: options.machine_code,
    platformTarget: options.platform_target,
    identity: options.identity,
    certificate: options.certificate,
    expectedTestbedUser: options.expected_testbed_user,
    sshKnownHostsPath: options.ssh_known_hosts_path,
    sshHostKeyAlias: options.ssh_host_key_alias,
    ...resolveRemoteOptions(options),
  };
}

export function buildInstalledKioskSaleScenarioSteps(
  profile: string,
): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [
    {
      type: "customer-activation",
      name: "catalog category",
      selector: '[data-test="catalog-category"]:not(:disabled)',
      routeBefore: "#/catalog",
      routeAfter: "#/catalog",
    },
    {
      type: "customer-activation",
      name: "catalog product",
      selector: '[data-test="catalog-product"]',
      routeBefore: "#/catalog",
      routeAfter: /^#\/products\//,
    },
    {
      type: "customer-activation",
      name: "buy",
      selector: '[data-test="product-buy"]',
      routeBefore: /^#\/products\//,
      routeAfter: "#/checkout",
    },
    {
      type: "customer-activation",
      name: "payment option",
      selector:
        '[data-test="payment-option"][data-payment-option-key="payment_code:mock"]:not(:disabled)',
      routeBefore: "#/checkout",
      routeAfter: "#/checkout",
    },
    {
      type: "customer-activation",
      name: "payment submit",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter:
        profile === "vm-route-competition" ? "#/checkout" : /^#\/payment/,
      timeoutMs: 30_000,
      activatesRouteBarrier: true,
      ...(profile === "vm-route-competition"
        ? { completesRouteBarrier: false }
        : {}),
      screenshot: true,
    },
  ];
  if (profile === "vm-route-competition") {
    steps.push({
      type: "customer-activation",
      name: "payment submit repeat",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: /^#\/payment/,
      timeoutMs: 30_000,
      completesRouteBarrier: true,
      repeatPreviousActivationCenter: true,
    });
    steps.push({
      type: "external-operation",
      name: "vision departure through daemon during payment",
      operation: "vision_departure",
      routeBefore: /^#\/payment/,
      routeAfter: /^#\/payment/,
      screenshot: true,
    });
    steps.push({
      type: "external-operation",
      name: "catalog projection refresh during payment",
      operation: "catalog_projection_refresh",
      routeBefore: /^#\/payment/,
      routeAfter: /^#\/payment/,
    });
  }
  if (profile === "vm-ipc-recovery") {
    steps.push({
      type: "external-operation",
      name: "daemon UI transport interruption during payment",
      operation: "daemon_transport_interrupt",
      routeBefore: /^#\/payment/,
      routeAfter: /^#\/payment/,
      screenshot: true,
    });
  }
  return steps;
}

export function buildInstalledKioskSaleLaunchFailureRecoveryScript(
  runtime: JsonRecord,
): string {
  if (
    !Number.isSafeInteger(runtime?.sessionId) ||
    (runtime.sessionId as number) < 1
  ) {
    throw new Error(
      "installed kiosk launch failure recovery requires the saved interactive session",
    );
  }
  const sessionUser = String(runtime.sessionUser ?? "").replaceAll("'", "''");
  return String.raw`
$ErrorActionPreference = 'Stop'
$debugTask = 'VEMInstalledKioskSaleDebug'
$normalTask = 'VEMMachineUI'
$machinePath = '${MACHINE_PATH}'
$sessionId = ${runtime.sessionId}
$expectedSessionUser = '${sessionUser}'
Stop-ScheduledTask -TaskName $debugTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $debugTask -Confirm:$false -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id ([int]$_.OwningProcess) -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
  $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) -and
  (Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue).SessionId -eq $sessionId
} | ForEach-Object {
  Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 300
$remainingDebugOwners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
if ($remainingDebugOwners.Count -ne 0) { throw 'launch failure cleanup retained a CDP owner' }
$remainingMachines = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
  $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) -and
  (Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue).SessionId -eq $sessionId
})
if ($remainingMachines.Count -ne 0) { throw 'launch failure cleanup retained a detached machine.exe' }
Start-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $machines = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath)
  })
  $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
  if ($machines.Count -eq 1 -and $listeners.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($machines.Count -ne 1 -or $listeners.Count -ne 0) { throw 'launch failure cleanup did not restore one normal machine.exe without CDP' }
$normalProcess = Get-Process -Id ([int]$machines[0].ProcessId) -ErrorAction Stop
$owner = Invoke-CimMethod -InputObject $machines[0] -MethodName GetOwner -ErrorAction Stop
$principal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
if ([string]$owner.User -cne $expectedSessionUser -and $principal -cne $expectedSessionUser) { throw 'launch failure cleanup restored the wrong interactive principal' }
if ($normalProcess.SessionId -ne $sessionId) { throw 'launch failure cleanup restored the wrong interactive session' }
[Console]::Out.WriteLine(([ordered]@{ ok = $true; recovery = 'launch_failure_normal_task_restart'; normalTask = $normalTask; cdpListenerCount = $listeners.Count; normal = [ordered]@{ processId = [int]$normalProcess.Id; principal = $principal; sessionId = [int]$normalProcess.SessionId; machineCount = $machines.Count } } | ConvertTo-Json -Compress))
`.trim();
}

export function buildInstalledKioskSerialActivationScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$health = $null
$bindings = $null
do {
  Start-Sleep -Milliseconds 500
  try {
    $ready = [System.IO.File]::ReadAllText('C:\ProgramData\VEM\vending-daemon\daemon-ready.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    $healthUrl = [uri][string]$ready.healthzUrl
    $baseUrl = "{0}://{1}:{2}" -f $healthUrl.Scheme, $healthUrl.Host, $healthUrl.Port
    $health = Invoke-RestMethod -Uri $ready.healthzUrl -Headers $headers -TimeoutSec 3
    $bindings = Invoke-RestMethod -Uri "$baseUrl/v1/hardware-bindings" -Headers $headers -TimeoutSec 3
    $lower = @($bindings.roles | Where-Object { [string]$_.role -eq 'lower_controller' })[0]
    $scanner = @($bindings.roles | Where-Object { [string]$_.role -eq 'scanner' })[0]
    $lowerPort = [string]$lower.currentPort
    $scannerPort = [string]$scanner.currentPort
    if (
      [bool]$health.hardwareOnline -and
      [bool]$health.scannerOnline -and
      $lower.ready -eq $true -and
      $scanner.ready -eq $true -and
      $lowerPort -match '^COM[1-9][0-9]*$' -and
      $scannerPort -match '^COM[1-9][0-9]*$' -and
      $lowerPort -cne $scannerPort
    ) { break }
  } catch {}
} while ([DateTime]::UtcNow -lt $deadline)
if (
  -not [bool]$health.hardwareOnline -or
  -not [bool]$health.scannerOnline -or
  $null -eq $bindings
) {
  $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
  $diagnostic = [ordered]@{
    lowerControllerPort = if ($null -ne $lower) { [string]$lower.currentPort } else { $null }
    scannerPort = if ($null -ne $scanner) { [string]$scanner.currentPort } else { $null }
    serviceStatus = if ($service) { [string]$service.Status } else { 'missing' }
    health = $health
    bindings = $bindings
  }
  throw "serial-backed daemon did not become ready with dynamic hardware bindings: $($diagnostic | ConvertTo-Json -Depth 30 -Compress)"
}
[Console]::Out.WriteLine(([ordered]@{
  ok = $true
  lowerControllerPort = [string]$lower.currentPort
  scannerPort = [string]$scanner.currentPort
  lowerControllerIdentityKey = [string]$lower.binding.identity.identityKey
  scannerIdentityKey = [string]$scanner.binding.identity.identityKey
  lowerControllerBindingReady = [bool]$lower.ready
  scannerBindingReady = [bool]$scanner.ready
  hardwareOnline = [bool]$health.hardwareOnline
  scannerOnline = [bool]$health.scannerOnline
} | ConvertTo-Json -Compress -Depth 30))
`.trim();
}

export function buildInstalledKioskSerialReadinessScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$health = $null
do {
  Start-Sleep -Milliseconds 500
  try {
    $ready = [System.IO.File]::ReadAllText('C:\ProgramData\VEM\vending-daemon\daemon-ready.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    $health = Invoke-RestMethod -Uri $ready.healthzUrl -Headers $headers -TimeoutSec 3
    if ([bool]$health.hardwareOnline -and [bool]$health.scannerOnline) { break }
  } catch {}
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $health -or -not [bool]$health.hardwareOnline -or -not [bool]$health.scannerOnline) {
  throw "serial-backed daemon lost hardware/scanner readiness after fixture"
}
[Console]::Out.WriteLine(([ordered]@{ ok = $true; hardwareOnline = [bool]$health.hardwareOnline; scannerOnline = [bool]$health.scannerOnline } | ConvertTo-Json -Compress))
`.trim();
}

export function buildInstalledKioskGuestOperationScript({
  operation,
  phase = "complete",
  operationId = `guest-operation-${randomBytes(12).toString("hex")}`,
  daemonRuntime = null,
  expectedTransaction = null,
}: {
  operation: string;
  phase?: string;
  operationId?: string;
  daemonRuntime?: Record<string, unknown> | null;
  expectedTransaction?: Record<string, unknown> | null;
}): string {
  if (
    ![
      "vision_departure",
      "catalog_projection_refresh",
      "daemon_transport_interrupt",
    ].includes(operation)
  ) {
    throw new Error("installed kiosk guest operation is invalid");
  }
  if (!["complete", "interrupt", "recover"].includes(phase)) {
    throw new Error("installed kiosk guest operation phase is invalid");
  }
  const daemonRuntimeJson = JSON.stringify(daemonRuntime ?? null).replaceAll(
    "'",
    "''",
  );
  const expectedTransactionJson = JSON.stringify(
    expectedTransaction ?? null,
  ).replaceAll("'", "''");
  return String.raw`
$ErrorActionPreference = 'Stop'
$operation = '${operation}'
$phase = '${phase}'
$guestOperationId = '${operationId}'
$ready = [System.IO.File]::ReadAllText('C:\ProgramData\VEM\vending-daemon\daemon-ready.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($ready.ipcToken)"; 'Content-Type' = 'application/json'; 'X-VEM-Guest-Operation-Id' = $guestOperationId }
$base = [string]$ready.healthzUrl -replace '/healthz$', ''
$service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
$consoleRuntime = '${daemonRuntimeJson}' | ConvertFrom-Json
$expectedTransaction = '${expectedTransactionJson}' | ConvertFrom-Json
$runtimeMode = if ($null -ne $service) { 'windows_service' } elseif ($null -ne $consoleRuntime -and [bool]$consoleRuntime.console) { 'console_process' } else { throw 'daemon runtime owner is unavailable' }
$daemonExecutablePath = if ($null -ne $consoleRuntime -and -not [string]::IsNullOrWhiteSpace([string]$consoleRuntime.executablePath)) { [IO.Path]::GetFullPath([string]$consoleRuntime.executablePath) } else { '' }
if ($phase -eq 'recover') {
  if ($runtimeMode -eq 'windows_service') {
    Start-Service -Name 'VemVendingDaemon' -ErrorAction Stop
  } else {
    $started = Start-Process -FilePath ([string]$consoleRuntime.executablePath) -ArgumentList @('--console', '--data-dir', [string]$consoleRuntime.dataDirectory) -WorkingDirectory ([string]$consoleRuntime.workingDirectory) -RedirectStandardOutput ([string]$consoleRuntime.stdoutPath) -RedirectStandardError ([string]$consoleRuntime.stderrPath) -PassThru
    $consoleRuntime.processId = $started.Id
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $ready = [System.IO.File]::ReadAllText('C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $headers = @{ Authorization = "Bearer $($ready.ipcToken)"; 'Content-Type' = 'application/json'; 'X-VEM-Guest-Operation-Id' = $guestOperationId }
      $base = [string]$ready.healthzUrl -replace '/healthz$', ''
      $health = Invoke-RestMethod -Uri $ready.healthzUrl -Headers $headers -TimeoutSec 3
    } catch { $health = $null }
  } while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $health) { throw 'daemon transport did not recover after the real service interruption' }
}
$before = if ($phase -eq 'recover') { $expectedTransaction } else { Invoke-RestMethod -Uri "$base/v1/transactions/current" -Headers $headers -TimeoutSec 10 }
if ([string]::IsNullOrWhiteSpace([string]$before.orderNo)) { throw 'guest operation requires an active daemon transaction' }
$daemonLogs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).ToUniversalTime().AddMinutes(-5) } -ErrorAction SilentlyContinue | Select-Object -First 32)
$logDigestInput = (($daemonLogs | ForEach-Object { "$($_.RecordId):$($_.ProviderName):$($_.Id):$($_.TimeCreated.ToUniversalTime().ToString('o'))" }) -join [Environment]::NewLine)
$logDigest = ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($logDigestInput)) | ForEach-Object { $_.ToString('x2') }) -join ''
if ($operation -eq 'vision_departure') {
  $vision = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:7893/control/departure' -ContentType 'application/json' -Body (@{ operationId = $guestOperationId; lastSeenAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress) -TimeoutSec 10
  if ($vision.ok -ne $true -or [string]::IsNullOrWhiteSpace([string]$vision.eventId)) { throw 'Vision control did not deliver departure to a live runtime client' }
} elseif ($operation -eq 'catalog_projection_refresh') {
  $catalog = Invoke-RestMethod -Method Post -Uri "$base/v1/catalog" -Headers $headers -TimeoutSec 15
  if ($null -eq $catalog.items) { throw 'daemon catalog projection did not return items' }
  $catalogRevision = ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($catalog | ConvertTo-Json -Compress -Depth 64))) | ForEach-Object { $_.ToString('x2') }) -join ''
  $catalogInvalidationId = "catalog-invalidation:$($guestOperationId):$catalogRevision"
} elseif ($phase -eq 'interrupt') {
  if ($runtimeMode -eq 'windows_service') {
    $serviceStopError = $null
    try {
      Stop-Service -Name 'VemVendingDaemon' -Force -ErrorAction Stop
    } catch {
      $serviceStopError = $_
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
      if ($null -eq $service -or [string]$service.Status -eq 'Stopped') { break }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
    if ($null -ne $service -and [string]$service.Status -ne 'Stopped') {
      Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and -not [string]::IsNullOrWhiteSpace($daemonExecutablePath) -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $daemonExecutablePath } |
        ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
      if ($null -eq $service -or [string]$service.Status -eq 'Stopped') { break }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
    if ($null -ne $service -and [string]$service.Status -ne 'Stopped') {
      $stopErrorText = if ($null -ne $serviceStopError) { [string]$serviceStopError.Exception.Message } else { '' }
      throw "VemVendingDaemon did not stop for daemon transport interrupt; status=$($service.Status); stopError=$stopErrorText"
    }
  } else {
    Stop-Process -Id ([int]$consoleRuntime.processId) -Force -ErrorAction Stop
  }
  [Console]::Out.WriteLine(([ordered]@{
    operation = $operation; guestOperationId = $guestOperationId; adapterSessionId = "daemon-ipc:$base"
    session = [ordered]@{ daemonReadyFile = 'C:\ProgramData\VEM\vending-daemon\daemon-ready.json'; daemonEndpoint = $base; runtimeMode = $runtimeMode; serviceName = if ($null -ne $service) { 'VemVendingDaemon' } else { $null }; serviceStatusBefore = if ($null -ne $service) { [string]$service.Status } else { 'Running' } }
    daemon = [ordered]@{ transactionBefore = [ordered]@{ orderNo = [string]$before.orderNo; updatedAt = [string]$before.updatedAt }; transport = [ordered]@{ phase = 'interrupted'; serviceStopped = $true } }
    platform = [ordered]@{ machineCode = [string]$before.machineCode; orderNo = [string]$before.orderNo }
    log = [ordered]@{ collector = 'windows_application_log'; recordCount = $daemonLogs.Count; digest = $logDigest; operationId = $guestOperationId }
    vision = [ordered]@{ eventId = $null; delivered = $false }
  } | ConvertTo-Json -Compress -Depth 12))
  exit 0
}
$after = Invoke-RestMethod -Uri "$base/v1/transactions/current" -Headers $headers -TimeoutSec 10
if ([string]$after.orderNo -cne [string]$before.orderNo) { throw 'daemon transport operation did not restore the same order' }
[Console]::Out.WriteLine(([ordered]@{
  operation = $operation
  guestOperationId = $guestOperationId
  adapterSessionId = "daemon-ipc:$base"
  session = [ordered]@{ daemonReadyFile = 'C:\ProgramData\VEM\vending-daemon\daemon-ready.json'; daemonEndpoint = $base; runtimeMode = $runtimeMode; serviceName = if ($null -ne $service) { 'VemVendingDaemon' } else { $null }; serviceStatusBefore = if ($null -ne $service) { [string]$service.Status } else { 'Stopped' }; serviceStatusAfter = if ($null -ne $service) { [string](Get-Service -Name 'VemVendingDaemon').Status } else { 'Running' } }
  daemon = [ordered]@{ transactionBefore = [ordered]@{ orderNo = [string]$before.orderNo; updatedAt = [string]$before.updatedAt }; transactionAfter = [ordered]@{ orderNo = [string]$after.orderNo; updatedAt = [string]$after.updatedAt }; runtimeTrace = [ordered]@{ eventId = if ($null -ne $vision) { [string]$vision.eventId } else { $null }; observedAt = (Get-Date).ToUniversalTime().ToString('o'); endpoint = "$base/v1/vision/status" }; catalog = [ordered]@{ revision = if ($null -ne $catalogRevision) { $catalogRevision } else { $null }; invalidationId = if ($null -ne $catalogInvalidationId) { $catalogInvalidationId } else { $null } }; transport = [ordered]@{ phase = if ($operation -eq 'daemon_transport_interrupt') { 'recovered' } else { 'uninterrupted' }; healthz = $null -ne $health } }
  platform = [ordered]@{ machineCode = [string]$after.machineCode; orderNo = [string]$after.orderNo }
  log = [ordered]@{ collector = 'windows_application_log'; recordCount = $daemonLogs.Count; digest = $logDigest; operationId = $guestOperationId }
  vision = [ordered]@{ eventId = if ($null -ne $vision) { [string]$vision.eventId } else { $null }; delivered = if ($null -ne $vision) { [int]$vision.acceptedDeliveries -gt 0 } else { $false }; operationId = $guestOperationId }
} | ConvertTo-Json -Compress -Depth 8))
`.trim();
}

function createRunnerTrust(root: string): InstalledKioskRunnerTrust {
  const signingKeyFile = join(root, "runner-ed25519.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(signingKeyFile, signingKeyPem, { mode: 0o600 });
  return {
    signingKeyFile,
    signingKeyPem,
    publicKey: `ed25519-public-key:base64:${publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`,
  };
}

function prepareScannerCode(
  options: JsonRecord,
  root: string,
): { path: string; code: Buffer; owned: boolean } {
  const path = join(root, "scanner-code.txt");
  const scannerCode = options.scanner_code_file
    ? readFileSync(String(options.scanner_code_file))
    : Buffer.from(`TEST-${randomBytes(8).toString("hex")}\r`, "utf8");
  if (scannerCode.length === 0) {
    throw new Error("--scanner-code-file must not be empty");
  }
  writeFileSync(path, scannerCode, {
    mode: 0o600,
  });
  return { path, code: scannerCode, owned: true };
}

function restoreConsumedSerialInputs(
  scanner: { path: string; code: Buffer },
  trust: { signingKeyFile: string; signingKeyPem: Buffer | string },
): void {
  restoreConsumedSerialInput(scanner.path, scanner.code);
  restoreConsumedSerialInput(trust.signingKeyFile, trust.signingKeyPem);
}

function restoreConsumedSerialInput(
  path: string,
  expected: Buffer | string,
): void {
  if (existsSync(path)) {
    const actual = readFileSync(path);
    if (!actual.equals(Buffer.from(expected))) {
      throw new Error(`serial input changed before reissue: ${path}`);
    }
    chmodSync(path, 0o600);
    return;
  }
  writeFileSync(path, expected, { mode: 0o600, flag: "wx" });
}

async function runCommand(
  command: string[],
  label: string,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<JsonRecord> {
  return new Promise<JsonRecord>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error(`${label} failed: ${error.message}`, { cause: error }));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed: ${stderr || stdout}`));
        return;
      }
      resolve({ status: code, stdout, stderr });
    });
  });
}

export function nonQueryChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
  return childEnvironment;
}

function writeJson(
  path: string,
  value: unknown,
  mode?: number,
): void {
  const resolved = resolve(path);
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify(value, null, 2)}\n`,
    mode ? { mode } : undefined,
  );
  renameSync(temporary, resolved);
}

function installedKioskScreenshotSink(root: string): (
  input: { bytes: Uint8Array; sha256: string; label: string },
) => Promise<{ ref: string }> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return ({ bytes, sha256, label }): Promise<{ ref: string }> => {
    const safeLabel = String(label).replaceAll(/[^A-Za-z0-9._-]+/g, "-");
    const path = join(root, `${safeLabel}-${sha256}.png`);
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
    return Promise.resolve({ ref: path });
  };
}

export function buildInstalledKioskFailureArtifactScript() {
  return String.raw`
$ErrorActionPreference = 'Continue'
$readyPath = 'C:\ProgramData\VEM\vending-daemon\daemon-ready.json'
$service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
$ready = $null
$transaction = $null
try {
  $ready = [System.IO.File]::ReadAllText($readyPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
  $base = [string]$ready.healthzUrl -replace '/healthz$', ''
  $transaction = Invoke-RestMethod -Uri "$base/v1/transactions/current" -Headers $headers -TimeoutSec 3
} catch {}
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).ToUniversalTime().AddMinutes(-10) } -ErrorAction SilentlyContinue | Select-Object -First 64)
$digestInput = (($events | ForEach-Object { "$($_.RecordId):$($_.ProviderName):$($_.Id):$($_.TimeCreated.ToUniversalTime().ToString('o'))" }) -join [Environment]::NewLine)
$digest = ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($digestInput)) | ForEach-Object { $_.ToString('x2') }) -join ''
[Console]::Out.WriteLine(([ordered]@{ schemaVersion = 'installed-kiosk-failure-daemon/v1'; capturedAt = (Get-Date).ToUniversalTime().ToString('o'); daemon = [ordered]@{ serviceStatus = if ($service) { [string]$service.Status } else { 'missing' }; readyFilePresent = Test-Path -LiteralPath $readyPath; transaction = $transaction }; log = [ordered]@{ collector = 'windows_application_log'; recordCount = $events.Count; digest = $digest } } | ConvertTo-Json -Compress -Depth 20))
`.trim();
}

function delayedPickupEvidenceIndex({
  track,
  liveEvidence = null,
  plan,
  scenario = null,
}: {
  track: JsonRecord | null | undefined;
  liveEvidence?: JsonRecord | null;
  plan: JsonRecord;
  scenario?: JsonRecord | null;
}): JsonRecord | null {
  if (!track) return null;
  const source = (liveEvidence ?? track) as JsonRecord;
  const sourcePaths = source.paths as JsonRecord;
  const planArtifacts = plan.artifacts as JsonRecord;
  const scenarioCheckpoints = (scenario?.checkpoints ?? []) as unknown[];
  const screenshots =
    scenarioCheckpoints
      .map(
        (checkpoint) =>
          ((checkpoint as JsonRecord)?.screenshot as JsonRecord | undefined)
            ?.ref,
      )
      .filter(Boolean) ?? [];
  return {
    platform: {
      baselinePath: planArtifacts.platformRawBaselineReport,
      atF1Path: sourcePaths.platformF1,
      postF2Path: planArtifacts.platformRawRecordsReport,
    },
    daemon: {
      evidencePath: sourcePaths.daemon,
    },
    serial: {
      conformancePath: planArtifacts.serialReport,
    },
    audio: {
      evidenceDirectory: source.evidenceDirectory,
      startReportPath: sourcePaths.audioStart,
      stopReportPath: sourcePaths.audioStop,
    },
    trace: {
      machineEvidencePath: sourcePaths.machine,
    },
    screenshots,
  };
}

function observedIdentity(
  values: unknown[],
  name: string,
): JsonRecord {
  const occurrences = values.filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  const unique = [...new Set(occurrences)];
  if (occurrences.length === 0 || unique.length !== 1) {
    throw new Error(`${name} must contain exactly one observed identity`);
  }
  return { occurrences, unique, count: occurrences.length };
}

function requiredRawRecords(platformRaw: JsonRecord): JsonRecord {
  if (
    platformRaw?.schemaVersion !==
      "installed-kiosk-sale-platform-raw-records/v3" ||
    platformRaw?.source !== "authoritative_ephemeral_platform_database" ||
    !platformRaw.raw ||
    typeof platformRaw.raw !== "object"
  ) {
    throw new Error(
      "authoritative platform raw query did not return the installed kiosk sale record contract",
    );
  }
  const names = [
    "orders",
    "orderItems",
    "payments",
    "paymentCodeAttempts",
    "reservations",
    "commands",
    "movements",
  ];
  const raw = platformRaw.raw as JsonRecord;
  for (const name of names) {
    if (!Array.isArray(raw[name])) {
      throw new Error(`authoritative platform raw query omitted ${name}`);
    }
  }
  return raw;
}

function rawRecordId(name: string, record: JsonRecord): string {
  const id = record?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `authoritative platform ${name} record omitted its stable id`,
    );
  }
  return id;
}

function paymentCodeAttemptDelta({
  baseline,
  post,
}: {
  baseline: JsonRecord;
  post: JsonRecord;
}): JsonRecord {
  const delta = postMinusBaselinePlatformRaw({ baseline, post });
  const raw = (delta.raw ?? {}) as JsonRecord;
  const attempts = Array.isArray(raw.paymentCodeAttempts)
    ? (raw.paymentCodeAttempts as unknown[])
    : [];
  if (attempts.length !== 1) {
    throw new Error(
      "authoritative platform raw query must expose exactly one new payment-code attempt",
    );
  }
  const attempt = attempts[0] as JsonRecord;
  if (
    typeof attempt?.id !== "string" ||
    attempt.id.length === 0 ||
    typeof attempt?.paymentId !== "string" ||
    attempt.paymentId.length === 0 ||
    typeof attempt?.orderId !== "string" ||
    attempt.orderId.length === 0 ||
    !Number.isInteger(attempt?.attemptNo) ||
    (attempt.attemptNo as number) < 1 ||
    typeof attempt?.idempotencyKey !== "string" ||
    attempt.idempotencyKey.length === 0
  ) {
    throw new Error(
      "authoritative platform payment-code attempt omitted its stable identity or attempt metadata",
    );
  }
  return { delta, attempt };
}

export function postMinusBaselinePlatformRaw({
  baseline,
  post,
}: {
  baseline: JsonRecord;
  post: JsonRecord;
}): JsonRecord {
  const baselineRaw = requiredRawRecords(baseline);
  const postRaw = requiredRawRecords(post);
  const baselineScope = baseline?.scope as JsonRecord | undefined;
  const postScope = post?.scope as JsonRecord | undefined;
  if (
    baselineScope?.runId !== postScope?.runId ||
    baselineScope?.machineCode !== postScope?.machineCode ||
    baselineScope?.machineId !== postScope?.machineId
  ) {
    throw new Error("authoritative platform baseline and post scopes differ");
  }
  const raw: JsonRecord = {};
  for (const name of [
    "orders",
    "orderItems",
    "payments",
    "paymentCodeAttempts",
    "reservations",
    "commands",
    "movements",
  ]) {
    const baselineIds = new Set(
      (baselineRaw[name] as unknown[]).map((record) =>
        rawRecordId(name, record as JsonRecord),
      ),
    );
    raw[name] = (postRaw[name] as unknown[]).filter(
      (record) =>
        !baselineIds.has(rawRecordId(name, record as JsonRecord)),
    );
  }
  return { scope: postScope, raw };
}

function serialSaleBinding(conformance: JsonRecord): JsonRecord {
  const injected = (
    (conformance?.reports as JsonRecord | undefined)?.inject as
      | JsonRecord
      | undefined
  )?.request as JsonRecord | undefined;
  const collected = (
    (conformance?.reports as JsonRecord | undefined)?.collect as
      | JsonRecord
      | undefined
  )?.request as JsonRecord | undefined;
  const injectedBindings = (injected?.serialSession as
    | JsonRecord
    | undefined)?.saleBindings;
  const collectedBindings = (collected?.serialSession as
    | JsonRecord
    | undefined)?.saleBindings;
  if (
    !Array.isArray(injectedBindings) ||
    !Array.isArray(collectedBindings) ||
    injectedBindings.length !== 1 ||
    collectedBindings.length !== 1
  ) {
    throw new Error(
      "serial conformance must expose exactly one injected and collected sale binding",
    );
  }
  return {
    injected: injectedBindings[0] as JsonRecord,
    collected: collectedBindings[0] as JsonRecord,
    counts: {
      injected: injectedBindings.length,
      collected: collectedBindings.length,
    },
  };
}

function terminalCheckpoint(scenario: JsonRecord): JsonRecord {
  const evidence = (scenario?.evidence ?? []) as unknown[];
  const checkpoints = evidence.filter(
    (entry) => {
      const entryRecord = entry as JsonRecord;
      return (
      entryRecord?.type === "checkpoint" &&
      entryRecord?.label === "continuous" &&
      /^#\/(dispensing|result)/.test(
        String(
          (entryRecord?.identity as JsonRecord | undefined)?.route ??
            entryRecord?.route ??
            "",
        ),
      )
      );
    },
  );
  const checkpoint = checkpoints?.at(-1);
  const checkpointRecord = checkpoint as JsonRecord | undefined;
  if (!checkpointRecord || !Number.isSafeInteger(checkpointRecord.ordinal)) {
    throw new Error(
      "fulfillment binding requires a continuous terminal checkpoint before catalog return",
    );
  }
  return checkpointRecord;
}

export function deriveFulfillmentBinding({
  payment,
  serial,
  completion,
  scenario,
  observedFulfillment = null,
}: {
  payment: JsonRecord;
  serial: JsonRecord;
  completion: JsonRecord;
  scenario: JsonRecord;
  observedFulfillment?: JsonRecord | null;
}): JsonRecord {
  const checkpoint = terminalCheckpoint(scenario);
  const bindings = serialSaleBinding(serial);
  const sale = ((completion?.simulatedHardwareSaleFlow as JsonRecord | undefined)
    ?.sale ?? {}) as JsonRecord;
  const commandId = sale?.vendingCommandId;
  const injectedBinding = bindings.injected as JsonRecord;
  const collectedBinding = bindings.collected as JsonRecord;
  const identitiesMatch =
    payment?.orderId === sale?.orderId &&
    payment?.paymentId === sale?.paymentId &&
    payment?.orderNo === sale?.orderNo &&
    injectedBinding.orderId === payment?.orderId &&
    injectedBinding.paymentId === payment?.paymentId &&
    collectedBinding.orderId === payment?.orderId &&
    collectedBinding.paymentId === payment?.paymentId &&
    collectedBinding.vendingCommandId === commandId;
  if (
    !identitiesMatch ||
    sale?.paymentStatus !== "succeeded" ||
    sale?.dispenseResult !== "dispensed" ||
    typeof commandId !== "string" ||
    commandId.length === 0
  ) {
    throw new Error(
      "terminal checkpoint, serial, and completion evidence do not bind one fulfillment",
    );
  }
  if (observedFulfillment != null) {
    if (
      observedFulfillment.orderId !== payment.orderId ||
      observedFulfillment.paymentId !== payment.paymentId ||
      observedFulfillment.orderNo !== payment.orderNo ||
      observedFulfillment.commandId !== commandId
    ) {
      throw new Error(
        "terminal fulfillment DOM probe does not match serial and completion evidence",
      );
    }
    return { ...observedFulfillment, source: "terminal_dom" };
  }
  return {
    source: "terminal_checkpoint_serial_completion",
    terminalRoute:
      (checkpoint.identity as JsonRecord | undefined)?.route ??
      checkpoint.route,
    terminalCheckpointOrdinal: checkpoint.ordinal,
    orderId: payment.orderId,
    paymentId: payment.paymentId,
    orderNo: payment.orderNo,
    commandId,
  };
}

export function deriveCorrelation({
  payment,
  fulfillment,
  serial,
  completion,
  platformRawBaseline,
  platformRawPost,
  runId,
  machineCode,
  saleCorrelationId,
}: {
  payment: JsonRecord;
  fulfillment: JsonRecord;
  serial: JsonRecord;
  completion: JsonRecord;
  platformRawBaseline: JsonRecord;
  platformRawPost: JsonRecord;
  runId: string;
  machineCode: string;
  saleCorrelationId: string;
}): JsonRecord {
  const platform = completion?.simulatedHardwareSaleFlow as
    | JsonRecord
    | undefined;
  const sale = platform?.sale as JsonRecord | undefined;
  const projectedMovementId = (
    (platform?.platformState as JsonRecord | undefined)
      ?.postSaleDispenseMovement as JsonRecord | undefined
  )?.movementId;
  const {
    delta: attemptDelta,
    attempt: rawAttemptValue,
  } = paymentCodeAttemptDelta({
    baseline: platformRawBaseline,
    post: platformRawPost,
  });
  const rawAttempt = rawAttemptValue as JsonRecord;
  const attemptDeltaRecord = attemptDelta as JsonRecord;
  const platformRawScope = attemptDeltaRecord.scope as
    | JsonRecord
    | undefined;
  const raw = (attemptDeltaRecord.raw ?? {}) as JsonRecord;
  const rawOrders = (raw.orders ?? []) as unknown[];
  const rawOrderItems = (raw.orderItems ?? []) as unknown[];
  const rawPayments = (raw.payments ?? []) as unknown[];
  const rawReservations = (raw.reservations ?? []) as unknown[];
  const rawCommands = (raw.commands ?? []) as unknown[];
  const rawMovements = (raw.movements ?? []) as unknown[];
  const rawPaymentCodeAttempts = (raw.paymentCodeAttempts ?? []) as unknown[];
  const rawOrder = rawOrders[0] as JsonRecord | undefined;
  const rawOrderItem = rawOrderItems[0] as JsonRecord | undefined;
  const rawPayment = rawPayments[0] as JsonRecord | undefined;
  const rawReservation = rawReservations[0] as JsonRecord | undefined;
  const rawCommand = rawCommands[0] as JsonRecord | undefined;
  const rawMovement = rawMovements[0] as JsonRecord | undefined;
  const bindings = serialSaleBinding(serial);
  const injectedBinding = bindings.injected as JsonRecord;
  const collectedBinding = bindings.collected as JsonRecord;
  const rendered = {
    orderId: String(payment.orderId),
    paymentId: String(payment.paymentId),
    orderNo: String(payment.orderNo),
    commandId: String(fulfillment.commandId),
  };
  const identitiesMatch =
    String(fulfillment.orderId) === rendered.orderId &&
    String(fulfillment.paymentId) === rendered.paymentId &&
    String(fulfillment.orderNo) === rendered.orderNo &&
    String(injectedBinding.orderId) === rendered.orderId &&
    String(injectedBinding.paymentId) === rendered.paymentId &&
    String(collectedBinding.orderId) === rendered.orderId &&
    String(collectedBinding.paymentId) === rendered.paymentId &&
    String(collectedBinding.vendingCommandId) === rendered.commandId &&
    String(sale?.orderId) === rendered.orderId &&
    String(sale?.paymentId) === rendered.paymentId &&
    String(sale?.orderNo) === rendered.orderNo &&
    String(sale?.vendingCommandId) === rendered.commandId &&
    String(rawOrder?.id) === rendered.orderId &&
    String(rawOrder?.orderNo) === rendered.orderNo &&
    String(rawPayment?.id) === rendered.paymentId &&
    String(rawPayment?.orderId) === rendered.orderId &&
    Boolean(rawAttempt?.id) &&
    String(rawAttempt?.orderId) === rendered.orderId &&
    String(rawAttempt?.paymentId) === rendered.paymentId &&
    rawAttempt?.attemptNo === 1 &&
    rawAttempt?.status === "succeeded" &&
    rawAttempt?.isActive === false &&
    rawAttempt?.source === "serial_text" &&
    String(rawCommand?.id) === rendered.commandId &&
    String(rawCommand?.orderId) === rendered.orderId &&
    String(rawMovement?.movementId) === String(projectedMovementId) &&
    String(rawMovement?.orderNo) === rendered.orderNo &&
    String(rawMovement?.orderItemId) === String(rawOrderItem?.id) &&
    String(rawMovement?.inventoryId) === String(rawOrderItem?.inventoryId) &&
    String(rawMovement?.slotId) === String(rawOrderItem?.slotId) &&
    String(rawMovement?.commandNo) === String(rawCommand?.commandNo);
  const observations = {
    orderIds: observedIdentity(
      rawOrders.map((record) => (record as JsonRecord)?.id),
      "platform order evidence",
    ),
    paymentIds: observedIdentity(
      rawPayments.map((record) => (record as JsonRecord)?.id),
      "platform payment evidence",
    ),
    paymentCodeAttemptIds: observedIdentity(
      rawPaymentCodeAttempts.map((record) => (record as JsonRecord)?.id),
      "platform payment-code-attempt evidence",
    ),
    paymentCodeAttemptNos: observedIdentity(
      rawPaymentCodeAttempts.map((record) =>
        String((record as JsonRecord)?.attemptNo ?? ""),
      ),
      "platform payment-code-attempt number evidence",
    ),
    paymentCodeIdempotencyKeys: observedIdentity(
      rawPaymentCodeAttempts.map(
        (record) => (record as JsonRecord)?.idempotencyKey,
      ),
      "platform payment-code-attempt idempotency evidence",
    ),
    orderNos: observedIdentity(
      rawOrders.map((record) => (record as JsonRecord)?.orderNo),
      "platform order-number evidence",
    ),
    orderItemIds: observedIdentity(
      rawOrderItems.map((record) => (record as JsonRecord)?.id),
      "platform order-item evidence",
    ),
    commandIds: observedIdentity(
      rawCommands.map((record) => (record as JsonRecord)?.id),
      "platform command evidence",
    ),
    movementIds: observedIdentity(
      rawMovements.map((record) => (record as JsonRecord)?.movementId),
      "platform movement evidence",
    ),
    reservationIds: observedIdentity(
      rawReservations.map((record) => (record as JsonRecord)?.id),
      "platform reservation evidence",
    ),
  };
  const reservationEvidenceMatches =
    rawOrderItems.length === 1 &&
    rawOrderItem?.id === (observations.orderItemIds.unique as unknown[])[0] &&
    rawOrderItem?.orderId === rendered.orderId &&
    rawOrderItem?.quantity === 1 &&
    rawReservations.length === 1 &&
    rawReservation?.id ===
      (observations.reservationIds.unique as unknown[])[0] &&
    rawReservation?.orderId === rendered.orderId &&
    rawReservation?.quantity === 1 &&
    rawReservation?.status === "confirmed" &&
    typeof rawReservation?.orderItemId === "string" &&
    rawReservation.orderItemId.length > 0 &&
    typeof rawReservation?.inventoryId === "string" &&
    rawReservation.inventoryId === rawOrderItem.inventoryId &&
    rawCommand?.orderItemId === rawReservation.orderItemId &&
    rawCommand?.orderItemId === rawOrderItem.id &&
    rawCommand?.slotId === rawOrderItem.slotId;
  const rawScopeMatches =
    platformRawScope?.runId === runId &&
    platformRawScope?.machineCode === machineCode &&
    typeof platformRawScope?.machineId === "string" &&
    rawOrder?.machineId === platformRawScope.machineId &&
    rawCommand?.machineId === platformRawScope.machineId &&
    rawMovement?.machineId === platformRawScope.machineId;
  const rawMovementMatches =
    rawMovement?.movementType === "dispense_succeeded" &&
    rawMovement?.quantity === 1 &&
    rawMovement?.status === "accepted";
  const exactOnce = {
    orderCount: observations.orderIds.count,
    paymentCount: observations.paymentIds.count,
    paymentCodeAttemptCount: observations.paymentCodeAttemptIds.count,
    orderNoCount: observations.orderNos.count,
    orderItemCount: observations.orderItemIds.count,
    reservationCount: observations.reservationIds.count,
    commandCount: observations.commandIds.count,
    movementCount: observations.movementIds.count,
    stockDelta: rawMovement ? -(rawMovement.quantity as number) : null,
    serialSaleBindingCount: bindings.counts,
  };
  if (
    !identitiesMatch ||
    !rawScopeMatches ||
    !reservationEvidenceMatches ||
    observations.orderIds.count !== 1 ||
    observations.paymentIds.count !== 1 ||
    observations.paymentCodeAttemptIds.count !== 1 ||
    observations.paymentCodeAttemptNos.count !== 1 ||
    observations.paymentCodeIdempotencyKeys.count !== 1 ||
    observations.orderNos.count !== 1 ||
    observations.orderItemIds.count !== 1 ||
    observations.reservationIds.count !== 1 ||
    observations.commandIds.count !== 1 ||
    observations.movementIds.count !== 1 ||
    !rawMovementMatches ||
    sale?.paymentStatus !== "succeeded" ||
    sale?.dispenseResult !== "dispensed"
  ) {
    throw new Error(
      "rendered payment, platform completion, and serial evidence do not prove one exact sale",
    );
  }
  return {
    saleCorrelationId,
    rendered,
    platform: {
      orderId: sale.orderId,
      paymentId: sale.paymentId,
      orderNo: sale.orderNo,
      paymentCodeAttempt: {
        attemptId: rawAttempt?.id,
        attemptNo: rawAttempt?.attemptNo,
        paymentId: rawAttempt?.paymentId,
        orderId: rawAttempt?.orderId,
        idempotencyKey: rawAttempt?.idempotencyKey,
        status: rawAttempt?.status,
        isActive: rawAttempt?.isActive,
        source: rawAttempt?.source,
      },
      commandId: sale?.vendingCommandId,
      stockMovementId: rawMovement?.movementId,
      stockDelta: rawMovement ? -(rawMovement.quantity as number) : null,
      status: rawMovement?.status,
      observations,
      orderItem: {
        id: rawOrderItem?.id,
        orderId: rawOrderItem?.orderId,
        inventoryId: rawOrderItem?.inventoryId,
        slotId: rawOrderItem?.slotId,
        quantity: rawOrderItem?.quantity,
      },
      reservation: {
        exposed: true,
        source: "authoritative_ephemeral_platform.inventory_reservations",
        rawRecordCount: rawReservations.length,
        reservationId: rawReservation?.id,
        orderId: rawReservation?.orderId,
        orderItemId: rawReservation?.orderItemId,
        inventoryId: rawReservation?.inventoryId,
        quantity: rawReservation?.quantity,
        status: rawReservation?.status,
      },
    },
    serial: {
      sessionId:
        ((serial.session as JsonRecord | undefined)?.serialSession as
          | JsonRecord
          | undefined)?.serialSessionId,
      injected: injectedBinding,
      collected: collectedBinding,
    },
    exactOnce,
  };
}

export function buildInstalledKioskSaleAcceptancePlan(rawOptions: JsonRecord) {
  const options = installedKioskSaleCliOptions(rawOptions);
  const remote = executionOptions(options);
  const outputRoot = dirname(resolve(options.out));
  const fixtureReport = join(
    outputRoot,
    "simulated-hardware-sale-fixture.json",
  );
  const completionReport = join(
    outputRoot,
    "simulated-hardware-sale-complete.json",
  );
  const scenarioReport = join(outputRoot, "machine-ui-cdp-sale-scenario.json");
  const bindingReport = join(outputRoot, "rendered-payment-binding.json");
  const serialReport = join(outputRoot, "serial-conformance.json");
  const serialPrestartReport = join(outputRoot, "serial-prestart.json");
  const platformRawRecordsReport = join(
    outputRoot,
    "platform-raw-records.json",
  );
  const platformRawBaselineReport = join(
    outputRoot,
    "platform-raw-records-baseline.json",
  );
  const screenshotDirectory = join(outputRoot, "machine-ui-screenshots");
  const failureArtifactReport = join(
    outputRoot,
    "installed-kiosk-sale-failure.json",
  );
  const failureTraceReport = join(
    outputRoot,
    "installed-kiosk-sale-failure-trace.json",
  );
  const failurePlatformReport = join(
    outputRoot,
    "installed-kiosk-sale-failure-platform.json",
  );
  const fixtureCommand = buildAcceptanceScriptCommand(
    "simulated-hardware-sale-flow",
    remote,
    [
      "--ephemeral-platform-evidence",
      options.ephemeral_platform_evidence,
      "--sale-phase",
      "fixture",
      ...(options.already_claimed ? ["--already-claimed"] : []),
      "--out",
      fixtureReport,
    ],
  );
  return {
    schemaVersion: "installed-kiosk-sale-acceptance-plan/v2",
    interface: "installed-kiosk-sale-acceptance",
    runId: options.run_id,
    profile: options.profile,
    runtimeAcceptanceReport: options.runtime_acceptance_report,
    fixtureCommand,
    artifacts: {
      report: options.out,
      fixtureReport,
      completionReport,
      scenarioReport,
      bindingReport,
      serialReport,
      serialPrestartReport,
      platformRawRecordsReport,
      platformRawBaselineReport,
      screenshotDirectory,
      failureArtifactReport,
      failureTraceReport,
      failurePlatformReport,
    },
  };
}

export async function runInstalledKioskSaleAcceptanceCli(
  rawOptions: JsonRecord,
  dependencies: InstalledKioskSaleDependencies = {},
) {
  const options = installedKioskSaleCliOptions(rawOptions);
  const queryDatabaseUrl = process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
  if (typeof queryDatabaseUrl !== "string" || queryDatabaseUrl.trim() === "") {
    throw new Error(`${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} is required`);
  }
  const plan = buildInstalledKioskSaleAcceptancePlan(options);
  const remote = executionOptions(options);
  const runtime = readRuntimeBinding(options.runtime_acceptance_report);
  mkdirSync(dirname(resolve(options.out)), { recursive: true, mode: 0o700 });
  rmSync(resolve(options.out), { force: true });
  const root = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "vem-installed-kiosk-sale-"),
  );
  chmodSync(root, 0o700);
  const trust = createRunnerTrust(root);
  const scanner = prepareScannerCode(options, root);
  const run = dependencies.runCommand ?? runCommand;
  const runRemote = dependencies.runRemote ?? runInstalledKioskSaleRemoteScript;
  const drive = dependencies.drive ?? runVisibleMachineSaleScenario;
  const capture = dependencies.capture ?? captureInstalledKioskSaleHook;
  const nonQueryEnvironment = nonQueryChildEnvironment();
  const queryEnvironment = {
    ...nonQueryEnvironment,
    [INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]: queryDatabaseUrl,
  };
  const saleCorrelationId = `sale-correlation://installed-kiosk-${options.run_id.toLowerCase()}`;
  let launch: JsonRecord | undefined;
  let cleanup: JsonRecord | undefined;
  let delayedPickupTrack: Awaited<
    ReturnType<typeof startDelayedPickupLiveProductionTrack>
  > | null = null;
  let primaryError: unknown;
  let scenario: JsonRecord | null = null;
  let report: InstalledKioskSaleReport = {
    schemaVersion: SCHEMA_VERSION,
    kind: "installed-kiosk-sale-acceptance",
    status: "failed",
    ok: false,
    runId: options.run_id,
    profile: options.profile,
    evidence: {
      scenarioPath: plan.artifacts.scenarioReport,
      serialConformancePath: plan.artifacts.serialReport,
      completionPath: plan.artifacts.completionReport,
      platformRawRecordsPath: plan.artifacts.platformRawRecordsReport,
      platformRawBaselinePath: plan.artifacts.platformRawBaselineReport,
    },
  };
  const platformRawQuery = (out: string): string[] => [
    process.execPath,
    "--conditions=vem-source",
    "--import",
    "tsx",
    "apps/service-api/src/testbed/query-installed-kiosk-sale-platform.cli.ts",
    "--run-id",
    options.run_id,
    "--machine-code",
    options.machine_code,
    "--out",
    out,
  ];
  try {
    await run(
      [
        process.execPath,
        "scripts/testbed/vm-host-adapter-serial-conformance.ts",
        "--adapter",
        options.adapter,
        "--scanner-code-file",
        scanner.path,
        "--runner-signing-key-file",
        trust.signingKeyFile,
        "--expected-runner-public-key",
        trust.publicKey,
        "--run-id",
        options.run_id,
        "--target-identity",
        options.target_identity,
        "--runtime-base",
        options.runtime_base,
        "--lifecycle-reference",
        options.lifecycle_reference ??
          `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
        "--sale-correlation-id",
        saleCorrelationId,
        "--start-only",
        "--out",
        plan.artifacts.serialPrestartReport,
      ],
      "serial conformance prestart",
      { env: nonQueryEnvironment },
    );
    runRemote(remote, buildInstalledKioskSerialActivationScript());
    await run(plan.fixtureCommand, "simulated hardware fixture", {
      env: nonQueryEnvironment,
    });
    // Bring-up applies the fixture's machine profile and can restart device
    // runtimes. Prove the production serial path is ready after that change,
    // immediately before the customer journey begins.
    runRemote(remote, buildInstalledKioskSerialReadinessScript());
    launch = runRemote(remote, buildInstalledKioskSaleLaunchScript());
    const launchPrelaunch = launch?.prelaunch as JsonRecord | undefined;
    const launchDebugTarget = launch?.debugTarget as JsonRecord | undefined;
    if (
      launchPrelaunch?.principal == null ||
      launchPrelaunch.sessionId !== runtime.sessionId ||
      launchPrelaunch.executablePath !== MACHINE_PATH ||
      !String(launchPrelaunch.principal)
        .toLowerCase()
        .endsWith(`\\${runtime.sessionUser.toLowerCase()}`) ||
      typeof launchDebugTarget?.id !== "string"
    ) {
      throw new Error(
        "temporary CDP launch did not preserve the active interactive process binding",
      );
    }
    const attestation = {
      targetId: launchDebugTarget?.id as string,
      machine: launch?.machine,
    };
    if (options.profile === "vm-delayed-pickup-native-audio") {
      const delayedRoot = join(
        dirname(resolve(options.out)),
        "delayed-pickup-native-audio",
      );
      delayedPickupTrack = await startDelayedPickupLiveProductionTrack({
        outputRoot: delayedRoot,
        runId: options.run_id,
        lifecycleReference:
          options.lifecycle_reference ??
          `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
        transactionId: `transaction://${options.run_id.toLowerCase()}.delayed-pickup`,
        saleCorrelationId,
        targetIdentity: options.target_identity,
        remote,
        async captureDaemon(stage, binding) {
          return runRemote(
            remote,
            buildDaemonFulfillmentStoreCheckpointScript({ stage, binding }),
          );
        },
        async queryPlatform(stage) {
          const out =
            stage === "baseline"
              ? plan.artifacts.platformRawBaselineReport
              : join(delayedRoot, "platform-raw-at-f1.json");
          await run(
            platformRawQuery(out),
            `authoritative platform ${stage} query`,
            {
              env: queryEnvironment,
            },
          );
          return JSON.parse(readFileSync(out, "utf8"));
        },
      });
      report.evidence.delayedPickupNativeAudio = delayedPickupEvidenceIndex({
        track: delayedPickupTrack,
        plan,
      });
    }
    // This must precede the first customer activation, including checkout submit.
    if (!delayedPickupTrack)
      await run(
        platformRawQuery(plan.artifacts.platformRawBaselineReport),
        "authoritative platform raw baseline query",
        { env: queryEnvironment },
      );
    let payment: JsonRecord | undefined;
    let serial: JsonRecord | undefined;
    let completion: JsonRecord | undefined;
    let fulfillmentProbe: JsonRecord | undefined;
    let fulfillmentProbeError: string | undefined;
    const drivenScenario = await drive({
      tunnelOptions: {
        remote: String(remote.remote ?? ""),
        sshPort: remote.sshPort as number | undefined,
        identityFile: String(remote.identity ?? ""),
        certificateFile: String(remote.certificate ?? ""),
        sshKnownHostsPath: String(remote.sshKnownHostsPath ?? ""),
        sshHostKeyAlias: String(remote.sshHostKeyAlias ?? ""),
        sshArgs: ["-o", "ProxyCommand=none"],
        remoteCdpPort: 9222,
      },
      expectedRuntimeAttestation: attestation,
      expectedInitialRoute: runtime.route,
      sequenceName: `installed-kiosk-${options.profile}`,
      adapter: {
        screenshotSink: installedKioskScreenshotSink(
          plan.artifacts.screenshotDirectory,
        ),
        async executeExternalOperation({ operation }: { operation: string }) {
          return runRemote(
            remote,
            buildInstalledKioskGuestOperationScript({ operation }),
          );
        },
        async beginExternalOperation({ operation }: { operation: string }) {
          if (operation !== "daemon_transport_interrupt") {
            throw new Error("only daemon transport interruption is two-phase");
          }
          const operationId = `guest-operation-${randomBytes(12).toString("hex")}`;
          const interrupted = runRemote(
            remote,
            buildInstalledKioskGuestOperationScript({
              operation,
              phase: "interrupt",
              operationId,
            }),
          );
          return { operationId, interrupted };
        },
        async completeExternalOperation(
          pending: { operationId: string; interrupted: Promise<JsonRecord> },
          { operation }: { operation: string },
        ) {
          const interrupted = (await pending.interrupted) as JsonRecord;
          const interruptedDaemon = interrupted.daemon as JsonRecord;
          const interruptedPlatform = interrupted.platform as JsonRecord;
          const recovered = runRemote(
            remote,
            buildInstalledKioskGuestOperationScript({
              operation,
              phase: "recover",
              operationId: pending.operationId,
              expectedTransaction: {
                ...(interruptedDaemon.transactionBefore as JsonRecord),
                machineCode: interruptedPlatform.machineCode,
              },
            }),
          );
          return recovered;
        },
      },
      screenshotCheckpoints: true,
      continuousCapture: true,
      steps: buildInstalledKioskSaleScenarioSteps(options.profile),
      onPaymentWindow: async () => {
        const paymentRecord = (await capture({
          options: remote,
          attestation,
          selector: "[data-installed-kiosk-sale-payment-surface]",
          route: /^#\/payment/,
        })) as JsonRecord;
        payment = paymentRecord;
        const binding = {
          orderId: paymentRecord.orderId,
          paymentId: paymentRecord.paymentId,
          orderNo: paymentRecord.orderNo,
          scenarioSha256: createHash("sha256")
            .update(`${options.run_id}:${paymentRecord.paymentId}`)
            .digest("hex"),
        };
        writeJson(plan.artifacts.bindingReport, binding, 0o600);
        const completionCommand = buildAcceptanceScriptCommand(
          "simulated-hardware-sale-flow",
          remote,
          [
            "--ephemeral-platform-evidence",
            options.ephemeral_platform_evidence,
            "--sale-phase",
            "complete",
            "--sale-binding-json",
            JSON.stringify(binding),
            "--out",
            plan.artifacts.completionReport,
          ],
        );
        const serialCommand = [
          process.execPath,
          "scripts/testbed/vm-host-adapter-serial-conformance.ts",
          "--adapter",
          options.adapter,
          "--scanner-code-file",
          scanner.path,
          "--runner-signing-key-file",
          trust.signingKeyFile,
          "--expected-runner-public-key",
          trust.publicKey,
          "--run-id",
          options.run_id,
          "--target-identity",
          options.target_identity,
          "--runtime-base",
          options.runtime_base,
          "--lifecycle-reference",
          options.lifecycle_reference ??
            `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
          "--sale-correlation-id",
          saleCorrelationId,
          "--machine-code",
          options.machine_code,
          "--ephemeral-platform-evidence",
          options.ephemeral_platform_evidence,
          "--customer-ui-sale-binding-file",
          plan.artifacts.bindingReport,
          "--prestarted-report",
          plan.artifacts.serialPrestartReport,
          "--sale-complete-command-json",
          JSON.stringify(completionCommand),
          "--out",
          plan.artifacts.serialReport,
        ];
        restoreConsumedSerialInputs(scanner, trust);
        await run(serialCommand, "serial conformance", {
          env: nonQueryEnvironment,
        });
        serial = JSON.parse(
          readFileSync(plan.artifacts.serialReport, "utf8"),
        ) as JsonRecord;
        completion = JSON.parse(
          readFileSync(plan.artifacts.completionReport, "utf8"),
        ) as JsonRecord;
        try {
          fulfillmentProbe = (await capture({
            options: remote,
            attestation,
            selector:
              "[data-installed-kiosk-sale-fulfillment-surface], [data-installed-kiosk-sale-result-surface]",
            route: /^#\/(dispensing|result)/,
          })) as JsonRecord;
        } catch (error) {
          fulfillmentProbeError =
            error instanceof Error ? error.message : String(error);
        }
        return {
          serialCompleted: true,
          postSaleStable: true,
        };
      },
    });
    scenario = (drivenScenario ?? null) as JsonRecord | null;
    writeJson(plan.artifacts.scenarioReport, scenario);
    if (!payment || !serial || !completion || !scenario || !launch) {
      throw new Error(
        "installed kiosk sale scenario did not complete the payment and serial chain",
      );
    }
    const completionFlow = completion?.simulatedHardwareSaleFlow as
      | JsonRecord
      | undefined;
    const completionPlatformState = completionFlow?.platformState as
      | JsonRecord
      | undefined;
    const projectedMovement = completionPlatformState
      ?.postSaleDispenseMovement as JsonRecord | undefined;
    const projectedMovementId = projectedMovement?.movementId;
    if (
      typeof projectedMovementId !== "string" ||
      projectedMovementId.trim() === ""
    ) {
      throw new Error(
        "simulated hardware completion did not expose a movement identity for authoritative platform verification",
      );
    }
    await run(
      platformRawQuery(plan.artifacts.platformRawRecordsReport),
      "authoritative platform raw post query",
      { env: queryEnvironment },
    );
    const platformRawBaseline = JSON.parse(
      readFileSync(plan.artifacts.platformRawBaselineReport, "utf8"),
    ) as JsonRecord;
    const platformRawPost = JSON.parse(
      readFileSync(plan.artifacts.platformRawRecordsReport, "utf8"),
    ) as JsonRecord;
    const fulfillment = deriveFulfillmentBinding({
      payment,
      serial,
      completion,
      scenario,
      observedFulfillment: fulfillmentProbe,
    });
    const correlation = deriveCorrelation({
      payment,
      fulfillment,
      serial,
      completion,
      platformRawBaseline,
      platformRawPost,
      runId: options.run_id,
      machineCode: options.machine_code,
      saleCorrelationId,
    });
    const errorMatrix = evaluateInstalledErrorMatrixEvidence({
      profile: options.profile,
      scenario,
      correlation,
    });
    report = {
      ...report,
      status: "passed",
      ok: true,
      runtimeBinding: {
        normal: runtime,
        prelaunch: launch.prelaunch,
        debug: {
          targetId: (launch?.debugTarget as JsonRecord | undefined)?.id,
          targetUrl: (launch?.debugTarget as JsonRecord | undefined)?.url,
          machine: launch?.machine,
        },
      },
      machineUiCdpScenario: scenario,
      fixture: JSON.parse(readFileSync(plan.artifacts.fixtureReport, "utf8")),
      correlation,
      errorMatrix,
      fulfillmentBinding: {
        ...fulfillment,
        currentDomProbe:
          fulfillmentProbeError == null ? "observed" : "returned_to_catalog",
      },
      evidence: {
        scenarioPath: plan.artifacts.scenarioReport,
        serialConformancePath: plan.artifacts.serialReport,
        completionPath: plan.artifacts.completionReport,
        platformRawRecordsPath: plan.artifacts.platformRawRecordsReport,
        platformRawBaselinePath: plan.artifacts.platformRawBaselineReport,
      },
    };
    if (delayedPickupTrack) {
      const platformRaw = platformRawPost.raw as JsonRecord;
      const commands = (platformRaw.commands ?? []) as unknown[];
      const command = commands.find(
        (entry: unknown) =>
          (entry as JsonRecord).id === fulfillment.commandId,
      ) as JsonRecord | undefined;
      if (typeof command?.commandNo !== "string")
        throw new Error("delayed pickup terminal command number is missing");
      const liveEvidence = await delayedPickupTrack.finish({
        runId: options.run_id,
        lifecycleReference:
          options.lifecycle_reference ??
          `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
        transactionId: `transaction://${options.run_id.toLowerCase()}.delayed-pickup`,
        saleCorrelationId,
        orderId: fulfillment.orderId,
        orderNo: fulfillment.orderNo,
        commandId: fulfillment.commandId,
        commandNo: command.commandNo,
      });
      const handoffPath = join(
        dirname(resolve(options.out)),
        "delayed-pickup-native-audio",
        "installed-sale-production-handoff.json",
      );
      writeJson(handoffPath, report, 0o600);
      const liveEvidencePaths = liveEvidence.paths as JsonRecord;
      const artifacts = collectDelayedPickupProductionEvidence({
        installedSaleReportPath: handoffPath,
        machineEvidencePath: String(liveEvidencePaths.machine),
        daemonEvidencePath: String(liveEvidencePaths.daemon),
        platformF1Path: String(liveEvidencePaths.platformF1),
        audioStartReportPath: String(liveEvidencePaths.audioStart),
        audioStopReportPath: String(liveEvidencePaths.audioStop),
      });
      const delayedAcceptance =
        verifyDelayedPickupNativeAudioProductionEvidence({
          artifacts,
          audioEvidenceDirectory: String(liveEvidence.evidenceDirectory),
        });
      report.evidence.delayedPickupNativeAudio = delayedPickupEvidenceIndex({
        track: delayedPickupTrack,
        liveEvidence,
        plan,
        scenario,
      });
      if (delayedAcceptance.result !== "passed")
        throw new Error(
          `delayed pickup native audio acceptance failed: ${JSON.stringify(delayedAcceptance.diagnostics)}`,
        );
      report.delayedPickupNativeAudio = delayedAcceptance;
      report.evidence.delayedPickupProductionHandoffPath = handoffPath;
    }
  } catch (error) {
    primaryError = error;
    const failure: {
      schemaVersion: string;
      capturedAt: string;
      error: string;
      daemon: JsonRecord | null;
      platform: {
        path: string;
        captured: boolean;
        error: string | null;
      };
      trace: { path: string };
      screenshots: string;
    } = {
      schemaVersion: "installed-kiosk-sale-failure/v1",
      capturedAt: new Date().toISOString(),
      error: formatInstalledKioskSaleError(error),
      daemon: null,
      platform: {
        path: plan.artifacts.failurePlatformReport,
        captured: false,
        error: null,
      },
      trace: { path: plan.artifacts.failureTraceReport },
      screenshots: plan.artifacts.screenshotDirectory,
    };
    try {
      failure.daemon = runRemote(
        remote,
        buildInstalledKioskFailureArtifactScript(),
      );
    } catch (captureError) {
      failure.daemon = {
        captureError: formatInstalledKioskSaleError(captureError),
      };
    }
    writeJson(
      plan.artifacts.failureTraceReport,
      { schemaVersion: "installed-kiosk-sale-failure-trace/v1", scenario },
      0o600,
    );
    try {
      await run(
        platformRawQuery(plan.artifacts.failurePlatformReport),
        "authoritative platform raw failure query",
        { env: queryEnvironment },
      );
      failure.platform.captured = existsSync(
        plan.artifacts.failurePlatformReport,
      );
    } catch (captureError) {
      failure.platform.error = formatInstalledKioskSaleError(captureError);
    }
    // The write is rename-based through writeJson, so a failed run never
    // publishes a partial daemon/platform/trace/screenshot manifest.
    writeJson(plan.artifacts.failureArtifactReport, failure, 0o600);
    report.evidence.failureArtifactPath = plan.artifacts.failureArtifactReport;
  } finally {
    try {
      await delayedPickupTrack?.close();
      if (launch?.prelaunch) {
        const launchPrelaunch = launch?.prelaunch as JsonRecord;
        const launchPrelaunchTask = launchPrelaunch.task as JsonRecord;
        cleanup = runRemote(
          remote,
          buildInstalledKioskSaleCleanupScript({
            ...launchPrelaunch,
            expectedRoute: "#/catalog",
          }),
        );
        const cleanupNormal = cleanup?.normal as JsonRecord | undefined;
        const cleanupNormalTask = cleanupNormal?.task as JsonRecord | undefined;
        if (
          cleanup?.restored !== "original_vem_machine_ui_task" ||
          cleanup?.daemonRunning !== true ||
          cleanup?.cdpListenerCount !== 0 ||
          cleanupNormal?.machineCount !== 1 ||
          cleanupNormal?.cdpListenerCount !== 0 ||
          cleanupNormalTask?.name !== "VEMMachineUI" ||
          cleanupNormalTask?.execute !== launchPrelaunchTask?.execute ||
          cleanupNormalTask?.arguments !== launchPrelaunchTask?.arguments ||
          cleanupNormalTask?.workingDirectory !==
            launchPrelaunchTask?.workingDirectory ||
          cleanupNormalTask?.xmlSha256 !== launchPrelaunchTask?.xmlSha256 ||
          cleanupNormalTask
            .triggersSettingsConditionsPrincipalActionRestored !== true ||
          cleanupNormal?.simulatedOrFaultProcessCount !== 0
        ) {
          throw new Error(
            "installed kiosk cleanup did not restore the original VEMMachineUI task without CDP",
          );
        }
      } else {
        cleanup = runRemote(
          remote,
          buildInstalledKioskSaleLaunchFailureRecoveryScript(runtime),
        );
        const cleanupNormal = cleanup?.normal as JsonRecord | undefined;
        if (
          cleanup?.recovery !== "launch_failure_normal_task_restart" ||
          cleanup?.normalTask !== "VEMMachineUI" ||
          cleanup?.cdpListenerCount !== 0 ||
          cleanupNormal?.machineCount !== 1 ||
          cleanupNormal?.sessionId !== runtime.sessionId ||
          !String(cleanupNormal?.principal ?? "")
            .toLowerCase()
            .endsWith(`\\${runtime.sessionUser.toLowerCase()}`)
        ) {
          throw new Error(
            "installed kiosk launch failure cleanup did not restore normal interactive ownership",
          );
        }
      }
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
      else
        primaryError = new AggregateError(
          [primaryError, cleanupError],
          "installed kiosk sale and cleanup failed",
        );
      report.cleanup = {
        status: "failed",
        error: formatInstalledKioskSaleError(cleanupError),
      };
    } finally {
      if (scanner.owned) rmSync(scanner.path, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (!report.cleanup) {
    report.cleanup = {
      status: "passed",
      normal: cleanup?.normal ?? null,
    };
  }
  if (delayedPickupTrack) {
    report.evidence.delayedPickupNativeAudio = delayedPickupEvidenceIndex({
      track: delayedPickupTrack,
      plan,
      scenario: report.machineUiCdpScenario as JsonRecord | null | undefined,
    });
  }
  if (primaryError) {
    report.status = "failed";
    report.ok = false;
    report.error = formatInstalledKioskSaleError(primaryError);
  }
  writeJson(options.out, report);
  if (primaryError) throw primaryError;
  return report;
}

export function formatInstalledKioskSaleError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.map(
        (cause: unknown, index: number) =>
          `cause ${index + 1}: ${formatInstalledKioskSaleError(cause)}`,
      ),
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

export function evaluateInstalledErrorMatrixEvidence({
  profile,
  scenario,
  correlation,
}: {
  profile: string;
  scenario: JsonRecord | null | undefined;
  correlation: JsonRecord | null | undefined;
}): JsonRecord {
  const expected =
    profile === "vm-route-competition"
      ? ["vision_departure", "catalog_projection_refresh"]
      : profile === "vm-ipc-recovery"
        ? ["daemon_transport_interrupt"]
        : [];
  const entries = Array.isArray(scenario?.evidence)
    ? (scenario.evidence as unknown[])
    : [];
  for (const operation of expected) {
    const entry = entries.find(
      (candidate: unknown) => {
        const record = candidate as JsonRecord;
        return (
          record?.type === "external-operation" &&
          record.operation === operation &&
          record.routeBefore === "#/payment" &&
          record.routeAfter === "#/payment"
        );
      },
    );
    const provenance = (entry as JsonRecord | undefined)?.provenance as
      | JsonRecord
      | undefined;
    const requiredString = (value: unknown, field: string): string => {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${operation} requires reproducible ${field}`);
      }
      return value;
    };
    if (!provenance || typeof provenance !== "object") {
      throw new Error(`${operation} requires operation provenance`);
    }
    const session = provenance.session as JsonRecord | undefined;
    const log = provenance.log as JsonRecord | undefined;
    const platform = provenance.platform as JsonRecord | undefined;
    const daemon = provenance.daemon as JsonRecord | undefined;
    const vision = provenance.vision as JsonRecord | undefined;
    const ui = provenance.ui as JsonRecord | undefined;
    const before = ui?.before as JsonRecord | undefined;
    const after = ui?.after as JsonRecord | undefined;
    const transactionBefore = daemon?.transactionBefore as
      | JsonRecord
      | undefined;
    const transactionAfter = daemon?.transactionAfter as
      | JsonRecord
      | undefined;
    requiredString(provenance.guestOperationId, "operation id");
    requiredString(provenance.adapterSessionId, "adapter session");
    requiredString(session?.daemonReadyFile, "daemon session ready file");
    requiredString(session?.daemonEndpoint, "daemon session endpoint");
    requiredString(log?.collector, "operation log collector");
    requiredString(log?.digest, "operation log digest");
    if (
      !Number.isInteger(log?.recordCount) ||
      (log?.recordCount as number) < 0
    ) {
      throw new Error(
        `${operation} requires a bounded operation log record count`,
      );
    }
    if (
      platform?.orderNo !==
        (correlation?.rendered as JsonRecord | undefined)?.orderNo ||
      platform?.orderNo !==
        (correlation?.platform as JsonRecord | undefined)?.orderNo
    ) {
      throw new Error(
        `${operation} platform fact does not bind the rendered order`,
      );
    }
    if (
      transactionBefore?.orderNo !==
        (correlation?.rendered as JsonRecord | undefined)?.orderNo ||
      transactionAfter?.orderNo !==
        (correlation?.rendered as JsonRecord | undefined)?.orderNo
    ) {
      throw new Error(
        `${operation} daemon transaction fact does not bind the rendered order`,
      );
    }
    if (operation === "vision_departure") {
      const eventId = requiredString(
        vision?.eventId,
        "Vision event id",
      );
      if (
        vision?.delivered !== true ||
        (daemon?.runtimeTrace as JsonRecord | undefined)?.eventId !== eventId ||
        !Array.isArray(after?.runtimeTrace) ||
        !(after?.runtimeTrace as unknown[]).some(
          (entry: unknown) =>
            (entry as JsonRecord)?.type === "navigation" &&
            (entry as JsonRecord)?.intentType === "presence.departed" &&
            (entry as JsonRecord)?.sourceEventId === eventId,
        )
      ) {
        throw new Error(
          "Vision departure must prove one eventId through Vision, daemon runtime trace, and UI trace",
        );
      }
    }
    if (operation === "catalog_projection_refresh") {
      const catalog = daemon?.catalog as JsonRecord | undefined;
      const revision = requiredString(
        catalog?.revision,
        "daemon catalog revision",
      );
      const invalidationId = requiredString(
        catalog?.invalidationId,
        "daemon catalog invalidation",
      );
      if (
        !invalidationId.includes(revision) ||
        after?.catalogRevision !== revision ||
        after?.catalogInvalidationId !== invalidationId ||
        !Array.isArray(after?.catalogRequests) ||
        (after?.catalogRequests as unknown[]).length <=
          ((before?.catalogRequests as unknown[] | undefined)?.length ?? 0)
      ) {
        throw new Error(
          "catalog refresh must prove the daemon revision and invalidation reached the UI",
        );
      }
    }
    if (operation === "daemon_transport_interrupt") {
      const overlay = ui?.recoveryOverlay as JsonRecord | undefined;
      const overlayScreenshot = overlay?.screenshot as JsonRecord | undefined;
      if (
        (daemon?.transport as JsonRecord | undefined)?.phase !== "recovered" ||
        (((overlay?.observation as JsonRecord | undefined)
          ?.recoveryOverlay as unknown[] | undefined)?.length ?? 0) < 1 ||
        !/^[a-f0-9]{64}$/.test(String(overlayScreenshot?.sha256 ?? "")) ||
        before?.orderCredential !==
          (correlation?.rendered as JsonRecord | undefined)?.orderNo ||
        after?.orderCredential !==
          (correlation?.rendered as JsonRecord | undefined)?.orderNo
      ) {
        throw new Error(
          "daemon transport recovery must preserve the rendered order credential and recovery-overlay screenshot",
        );
      }
    }
  }
  return { status: "passed", operations: expected };
}

function usage() {
  console.error(
    `Usage: VEM_INSTALLED_KIOSK_SALE_DATABASE_URL=... installed-kiosk-sale-acceptance.ts --run-id ID --machine-code CODE --platform-target TARGET --ephemeral-platform-evidence PATH --runtime-acceptance-report PATH (--remote USER@HOST | --runtime-guest-endpoint-json JSON --expected-testbed-user USER) --identity KEY --certificate CERT --adapter PATH --target-identity ID --runtime-base runtime-base://sha256/HASH [--scanner-code-file PATH] [--profile vm-normal|vm-route-competition] --out PATH [--dry-run]`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      const plan = buildInstalledKioskSaleAcceptancePlan(options);
      if (options.dryRun) {
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
      }
      const report = await runInstalledKioskSaleAcceptanceCli(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      console.error(formatInstalledKioskSaleError(error));
      usage();
      process.exitCode = 2;
    }
  })();
}
