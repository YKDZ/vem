#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  routeFromTauriUrl,
  runVisibleMachineSaleScenario,
} from "./machine-ui-cdp-driver.mjs";
import {
  buildAcceptanceScriptCommand,
  buildInstalledKioskSaleCleanupScript,
  buildInstalledKioskSaleLaunchScript,
  captureInstalledKioskSaleHook,
  runInstalledKioskSaleRemoteScript,
} from "./win10-vem-e2e.mjs";

const SCHEMA_VERSION = "installed-kiosk-sale-acceptance/v2";
const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";
const PROFILE_NAMES = new Set([
  "vm-normal",
  "vm-route-competition",
  "factory-route-competition",
]);
const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";

function required(options, name) {
  const value = options[name.replaceAll("-", "_")];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const options = {};
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
    "factory-guest-endpoint-json",
    "adapter",
    "target-identity",
    "approved-runtime-base",
    "scanner-code-file",
    "maintenance-relay-session-json",
    "maintenance-endpoint-policy-json",
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
    "approved_runtime_base",
    "out",
  ]) {
    required(options, name.replaceAll("_", "-"));
  }
  if (options.profile == null) options.profile = "vm-normal";
  if (!PROFILE_NAMES.has(options.profile)) {
    throw new Error(
      "--profile must be vm-normal, vm-route-competition, or factory-route-competition",
    );
  }
  if (options.ssh_port != null) {
    options.ssh_port = Number(options.ssh_port);
    if (!Number.isInteger(options.ssh_port) || options.ssh_port < 1) {
      throw new Error("--ssh-port must be a positive integer");
    }
  }
  return options;
}

function readRuntimeBinding(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const runtime = report?.runtimeAcceptanceReport;
  const kiosk = runtime?.kioskRuntime;
  const cdpRoute =
    typeof kiosk?.url === "string" &&
    kiosk.url.startsWith("http://tauri.localhost/#/");
  const productionNormalUi =
    kiosk?.source === "webview2_process" &&
    kiosk?.cdpAvailable === false &&
    kiosk?.url === "unavailable:production-cdp-disabled" &&
    kiosk?.machineProcessCount === 1 &&
    kiosk?.machineExecutablePath === "C:\\VEM\\bringup\\machine.exe" &&
    kiosk?.webView2ProcessCount >= 1;
  if (
    report?.ok !== true ||
    runtime?.schemaVersion !== "runtime-acceptance-report/v1" ||
    kiosk?.sessionUser?.toLowerCase() !== "vemkiosk" ||
    !Number.isInteger(kiosk?.sessionId) ||
    kiosk.sessionId < 1 ||
    (!cdpRoute && !productionNormalUi)
  ) {
    throw new Error(
      "runtime acceptance report must prove an active VEMKiosk session",
    );
  }
  return {
    normalTargetId:
      cdpRoute && typeof kiosk.cdpTargetId === "string" && kiosk.cdpTargetId
        ? kiosk.cdpTargetId
        : null,
    sessionUser: "VEMKiosk",
    sessionId: kiosk.sessionId,
    route: cdpRoute ? routeFromTauriUrl(kiosk.url) : "#/catalog",
    url: kiosk.url,
    productionCdpDisabled: productionNormalUi,
  };
}

function resolveRemoteOptions(options) {
  const remote = options.remote;
  const endpointJson = options.factory_guest_endpoint_json;
  if (remote && endpointJson) {
    throw new Error(
      "--remote and --factory-guest-endpoint-json are mutually exclusive",
    );
  }
  if (remote) return { remote, sshPort: options.ssh_port };
  let endpoint;
  try {
    endpoint = JSON.parse(required(options, "factory-guest-endpoint-json"));
  } catch {
    throw new Error(
      "--factory-guest-endpoint-json must contain a discovered SSH endpoint",
    );
  }
  if (
    endpoint?.protocol !== "ssh" ||
    typeof endpoint.host !== "string" ||
    !Number.isInteger(endpoint.port) ||
    !options.expected_testbed_user
  ) {
    throw new Error(
      "factory guest endpoint requires protocol, host, port, and --expected-testbed-user",
    );
  }
  return {
    remote: `${options.expected_testbed_user}@${endpoint.host}`,
    sshPort: endpoint.port,
    sshHostKeyAlias:
      options.ssh_host_key_alias ??
      `vem-installed-kiosk-${options.run_id.toLowerCase()}`,
  };
}

function executionOptions(options) {
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

export function buildInstalledKioskSaleScenarioSteps(profile) {
  const steps = [
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
        '[data-test="payment-option"][data-payment-option-key="mock:mock"]:not(:disabled)',
      routeBefore: "#/checkout",
      routeAfter: "#/checkout",
    },
    {
      type: "customer-activation",
      name: "payment submit",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: /^#\/payment/,
      timeoutMs: 30_000,
      activatesRouteBarrier: true,
      screenshot: true,
    },
  ];
  if (profile !== "vm-normal") {
    steps.push({
      type: "debug-disturbance",
      name: "catalog refresh during payment",
      disturbance: "catalog_refresh",
      routeBefore: /^#\/payment/,
      routeAfter: /^#\/payment/,
    });
    steps.push({
      type: "route-action",
      name: "history competition during payment",
      stimulus: "history-back",
      routeBefore: /^#\/payment/,
      routeAfter: /^#\/payment/,
    });
  }
  return steps;
}

export function buildInstalledKioskSaleLaunchFailureRecoveryScript(runtime) {
  if (!Number.isSafeInteger(runtime?.sessionId) || runtime.sessionId < 1) {
    throw new Error(
      "installed kiosk launch failure recovery requires the saved VEMKiosk session",
    );
  }
  return String.raw`
$ErrorActionPreference = 'Stop'
$debugTask = 'VEMInstalledKioskSaleDebug'
$normalTask = 'VEMMachineUI'
$machinePath = '${MACHINE_PATH}'
$sessionId = ${runtime.sessionId}
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
if ($principal -notmatch '(?i)\\VEMKiosk$' -or $normalProcess.SessionId -ne $sessionId) { throw 'launch failure cleanup restored the wrong kiosk ownership or session' }
[Console]::Out.WriteLine(([ordered]@{ ok = $true; recovery = 'launch_failure_normal_task_restart'; normalTask = $normalTask; cdpListenerCount = $listeners.Count; normal = [ordered]@{ processId = [int]$normalProcess.Id; principal = $principal; sessionId = [int]$normalProcess.SessionId; machineCount = $machines.Count } } | ConvertTo-Json -Compress))
`.trim();
}

export function buildInstalledKioskSerialActivationScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ports = @([System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_.ToUpperInvariant() } | Sort-Object { [int]($_ -replace '^COM', '') })
if ($ports.Count -lt 2) { throw "installed kiosk serial activation requires two COM ports, found $($ports.Count)" }
$lowerPort = if ($ports -contains 'COM1') { 'COM1' } else { $ports[0] }
$scannerPort = if ($ports -contains 'COM2') { 'COM2' } else { @($ports | Where-Object { $_ -ne $lowerPort })[0] }
Stop-Service -Name 'VemVendingDaemon' -Force
foreach ($path in @('C:\ProgramData\VEM\vending-daemon\machine-config.json', 'C:\VEM\bringup\machine-config.json')) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
  $config = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  foreach ($entry in @{ hardwareAdapter = 'serial'; serialPortPath = $lowerPort; lowerControllerUsbIdentity = $null; scannerAdapter = 'serial_text'; scannerSerialPortPath = $scannerPort; scannerUsbIdentity = $null }.GetEnumerator()) {
    if ($config.PSObject.Properties.Name -contains $entry.Key) { $config.($entry.Key) = $entry.Value }
    else { $config | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value }
  }
  [System.IO.File]::WriteAllText($path, ($config | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
}
$localSettingsPath = 'C:\ProgramData\VEM\bringup\local-settings.json'
$localSettings = [System.IO.File]::ReadAllText($localSettingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($entry in @{ hardwareAdapter = 'serial'; serialPortPath = $lowerPort; lowerControllerUsbIdentity = $null; scannerAdapter = 'serial_text'; scannerSerialPortPath = $scannerPort; scannerUsbIdentity = $null }.GetEnumerator()) {
  if ($localSettings.PSObject.Properties.Name -contains $entry.Key) { $localSettings.($entry.Key) = $entry.Value }
  else { $localSettings | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value }
}
[System.IO.File]::WriteAllText($localSettingsPath, ($localSettings | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
Start-Service -Name 'VemVendingDaemon'
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $ready = [System.IO.File]::ReadAllText('C:\ProgramData\VEM\vending-daemon\daemon-ready.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    $health = Invoke-RestMethod -Uri $ready.healthzUrl -Headers $headers -TimeoutSec 3
    if ([bool]$health.hardwareOnline -and [bool]$health.scannerOnline) { break }
  } catch {}
} while ([DateTime]::UtcNow -lt $deadline)
if (-not [bool]$health.hardwareOnline -or -not [bool]$health.scannerOnline) {
  $service = Get-Service -Name 'VemVendingDaemon' -ErrorAction SilentlyContinue
  $diagnostic = [ordered]@{
    ports = $ports
    lowerControllerPort = $lowerPort
    scannerPort = $scannerPort
    serviceStatus = if ($service) { [string]$service.Status } else { 'missing' }
    localSettings = [System.IO.File]::ReadAllText($localSettingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    machineConfig = [System.IO.File]::ReadAllText('C:\ProgramData\VEM\vending-daemon\machine-config.json', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    health = $health
  }
  throw "serial-backed daemon did not become hardware/scanner ready: $($diagnostic | ConvertTo-Json -Depth 30 -Compress)"
}
[Console]::Out.WriteLine(([ordered]@{ ok = $true; lowerControllerPort = $lowerPort; scannerPort = $scannerPort; hardwareOnline = [bool]$health.hardwareOnline; scannerOnline = [bool]$health.scannerOnline } | ConvertTo-Json -Compress))
`.trim();
}

function createRunnerTrust(root) {
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

function prepareScannerCode(options, root) {
  const path = join(root, "scanner-code.txt");
  const scannerCode = options.scanner_code_file
    ? readFileSync(options.scanner_code_file, "utf8")
    : `TEST-${randomBytes(8).toString("hex")}\n`;
  if (scannerCode.length === 0) {
    throw new Error("--scanner-code-file must not be empty");
  }
  writeFileSync(path, scannerCode, {
    mode: 0o600,
  });
  return { path, code: scannerCode, owned: true };
}

function restoreConsumedSerialInputs(scanner, trust) {
  restoreConsumedSerialInput(scanner.path, scanner.code);
  restoreConsumedSerialInput(trust.signingKeyFile, trust.signingKeyPem);
}

function restoreConsumedSerialInput(path, expected) {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== expected) {
      throw new Error(`serial input changed before reissue: ${path}`);
    }
    chmodSync(path, 0o600);
    return;
  }
  writeFileSync(path, expected, { mode: 0o600, flag: "wx" });
}

async function runCommand(command, label, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
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

export function nonQueryChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
  return childEnvironment;
}

function writeJson(path, value, mode) {
  writeFileSync(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    mode ? { mode } : undefined,
  );
}

function observedIdentity(values, name) {
  const occurrences = values.filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  const unique = [...new Set(occurrences)];
  if (occurrences.length === 0 || unique.length !== 1) {
    throw new Error(`${name} must contain exactly one observed identity`);
  }
  return { occurrences, unique, count: occurrences.length };
}

function requiredRawRecords(platformRaw) {
  if (
    platformRaw?.schemaVersion !==
      "installed-kiosk-sale-platform-raw-records/v2" ||
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
    "reservations",
    "commands",
    "movements",
  ];
  for (const name of names) {
    if (!Array.isArray(platformRaw.raw[name])) {
      throw new Error(`authoritative platform raw query omitted ${name}`);
    }
  }
  return platformRaw.raw;
}

function rawRecordId(name, record) {
  const id = record?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `authoritative platform ${name} record omitted its stable id`,
    );
  }
  return id;
}

export function postMinusBaselinePlatformRaw({ baseline, post }) {
  const baselineRaw = requiredRawRecords(baseline);
  const postRaw = requiredRawRecords(post);
  if (
    baseline?.scope?.runId !== post?.scope?.runId ||
    baseline?.scope?.machineCode !== post?.scope?.machineCode ||
    baseline?.scope?.machineId !== post?.scope?.machineId
  ) {
    throw new Error("authoritative platform baseline and post scopes differ");
  }
  const raw = {};
  for (const name of [
    "orders",
    "orderItems",
    "payments",
    "reservations",
    "commands",
    "movements",
  ]) {
    const baselineIds = new Set(
      baselineRaw[name].map((record) => rawRecordId(name, record)),
    );
    raw[name] = postRaw[name].filter(
      (record) => !baselineIds.has(rawRecordId(name, record)),
    );
  }
  return { scope: post.scope, raw };
}

function serialSaleBinding(conformance) {
  const injected =
    conformance?.reports?.inject?.request?.serialSession?.saleBindings;
  const collected =
    conformance?.reports?.collect?.request?.serialSession?.saleBindings;
  if (
    !Array.isArray(injected) ||
    !Array.isArray(collected) ||
    injected.length !== 1 ||
    collected.length !== 1
  ) {
    throw new Error(
      "serial conformance must expose exactly one injected and collected sale binding",
    );
  }
  return {
    injected: injected[0],
    collected: collected[0],
    counts: { injected: injected.length, collected: collected.length },
  };
}

function terminalCheckpoint(scenario) {
  const checkpoints = scenario?.evidence?.filter(
    (entry) =>
      entry?.type === "checkpoint" &&
      entry?.label === "continuous" &&
      /^#\/(dispensing|result)/.test(
        entry?.identity?.route ?? entry?.route ?? "",
      ),
  );
  const checkpoint = checkpoints?.at(-1);
  if (!checkpoint || !Number.isSafeInteger(checkpoint.ordinal)) {
    throw new Error(
      "fulfillment binding requires a continuous terminal checkpoint before catalog return",
    );
  }
  return checkpoint;
}

export function deriveFulfillmentBinding({
  payment,
  serial,
  completion,
  scenario,
  observedFulfillment = null,
}) {
  const checkpoint = terminalCheckpoint(scenario);
  const bindings = serialSaleBinding(serial);
  const sale = completion?.simulatedHardwareSaleFlow?.sale;
  const commandId = sale?.vendingCommandId;
  const identitiesMatch =
    payment?.orderId === sale?.orderId &&
    payment?.paymentId === sale?.paymentId &&
    payment?.orderNo === sale?.orderNo &&
    bindings.injected.orderId === payment?.orderId &&
    bindings.injected.paymentId === payment?.paymentId &&
    bindings.collected.orderId === payment?.orderId &&
    bindings.collected.paymentId === payment?.paymentId &&
    bindings.collected.vendingCommandId === commandId;
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
    terminalRoute: checkpoint.identity?.route ?? checkpoint.route,
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
}) {
  const platform = completion?.simulatedHardwareSaleFlow;
  const sale = platform?.sale;
  const projectedMovementId =
    platform?.platformState?.postSaleDispenseMovement?.movementId;
  const { scope: platformRawScope, raw } = postMinusBaselinePlatformRaw({
    baseline: platformRawBaseline,
    post: platformRawPost,
  });
  const rawOrder = raw.orders[0] ?? null;
  const rawOrderItem = raw.orderItems[0] ?? null;
  const rawPayment = raw.payments[0] ?? null;
  const rawReservation = raw.reservations[0] ?? null;
  const rawCommand = raw.commands[0] ?? null;
  const rawMovement = raw.movements[0] ?? null;
  const bindings = serialSaleBinding(serial);
  const rendered = {
    orderId: payment.orderId,
    paymentId: payment.paymentId,
    orderNo: payment.orderNo,
    commandId: fulfillment.commandId,
  };
  const identitiesMatch =
    fulfillment.orderId === rendered.orderId &&
    fulfillment.paymentId === rendered.paymentId &&
    fulfillment.orderNo === rendered.orderNo &&
    bindings.injected.orderId === rendered.orderId &&
    bindings.injected.paymentId === rendered.paymentId &&
    bindings.collected.orderId === rendered.orderId &&
    bindings.collected.paymentId === rendered.paymentId &&
    bindings.collected.vendingCommandId === rendered.commandId &&
    sale?.orderId === rendered.orderId &&
    sale?.paymentId === rendered.paymentId &&
    sale?.orderNo === rendered.orderNo &&
    sale?.vendingCommandId === rendered.commandId &&
    rawOrder?.id === rendered.orderId &&
    rawOrder?.orderNo === rendered.orderNo &&
    rawPayment?.id === rendered.paymentId &&
    rawPayment?.orderId === rendered.orderId &&
    rawCommand?.id === rendered.commandId &&
    rawCommand?.orderId === rendered.orderId &&
    rawMovement?.movementId === projectedMovementId &&
    rawMovement?.orderNo === rendered.orderNo &&
    rawMovement?.orderItemId === rawOrderItem?.id &&
    rawMovement?.inventoryId === rawOrderItem?.inventoryId &&
    rawMovement?.slotId === rawOrderItem?.slotId &&
    rawMovement?.commandNo === rawCommand?.commandNo;
  const observations = {
    orderIds: observedIdentity(
      raw.orders.map((record) => record?.id),
      "platform order evidence",
    ),
    paymentIds: observedIdentity(
      raw.payments.map((record) => record?.id),
      "platform payment evidence",
    ),
    orderNos: observedIdentity(
      raw.orders.map((record) => record?.orderNo),
      "platform order-number evidence",
    ),
    orderItemIds: observedIdentity(
      raw.orderItems.map((record) => record?.id),
      "platform order-item evidence",
    ),
    commandIds: observedIdentity(
      raw.commands.map((record) => record?.id),
      "platform command evidence",
    ),
    movementIds: observedIdentity(
      raw.movements.map((record) => record?.movementId),
      "platform movement evidence",
    ),
    reservationIds: observedIdentity(
      raw.reservations.map((record) => record?.id),
      "platform reservation evidence",
    ),
  };
  const reservationEvidenceMatches =
    raw.orderItems.length === 1 &&
    rawOrderItem?.id === observations.orderItemIds.unique[0] &&
    rawOrderItem?.orderId === rendered.orderId &&
    rawOrderItem?.quantity === 1 &&
    raw.reservations.length === 1 &&
    rawReservation?.id === observations.reservationIds.unique[0] &&
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
    orderNoCount: observations.orderNos.count,
    orderItemCount: observations.orderItemIds.count,
    reservationCount: observations.reservationIds.count,
    commandCount: observations.commandIds.count,
    movementCount: observations.movementIds.count,
    stockDelta: rawMovement ? -rawMovement.quantity : null,
    serialSaleBindingCount: bindings.counts,
  };
  if (
    !identitiesMatch ||
    !rawScopeMatches ||
    !reservationEvidenceMatches ||
    observations.orderIds.count !== 1 ||
    observations.paymentIds.count !== 1 ||
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
      commandId: sale.vendingCommandId,
      stockMovementId: rawMovement.movementId,
      stockDelta: -rawMovement.quantity,
      status: rawMovement.status,
      observations,
      orderItem: {
        id: rawOrderItem.id,
        orderId: rawOrderItem.orderId,
        inventoryId: rawOrderItem.inventoryId,
        slotId: rawOrderItem.slotId,
        quantity: rawOrderItem.quantity,
      },
      reservation: {
        exposed: true,
        source: "authoritative_ephemeral_platform.inventory_reservations",
        rawRecordCount: raw.reservations.length,
        reservationId: rawReservation.id,
        orderId: rawReservation.orderId,
        orderItemId: rawReservation.orderItemId,
        inventoryId: rawReservation.inventoryId,
        quantity: rawReservation.quantity,
        status: rawReservation.status,
      },
    },
    serial: {
      sessionId: serial.session?.serialSessionId,
      injected: bindings.injected,
      collected: bindings.collected,
    },
    exactOnce,
  };
}

export function buildInstalledKioskSaleAcceptancePlan(options) {
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
    },
  };
}

export async function runInstalledKioskSaleAcceptanceCli(
  options,
  dependencies = {},
) {
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
  const serialEndpointArgs = [];
  if (options.maintenance_relay_session_json) {
    serialEndpointArgs.push(
      "--maintenance-relay-session-json",
      options.maintenance_relay_session_json,
    );
  }
  if (options.maintenance_endpoint_policy_json) {
    serialEndpointArgs.push(
      "--maintenance-endpoint-policy-json",
      options.maintenance_endpoint_policy_json,
    );
  }
  let launch;
  let cleanup;
  let primaryError;
  let report;
  try {
    await run(
      [
        process.execPath,
        "scripts/testbed/vm-host-adapter-serial-conformance.mjs",
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
        "--approved-runtime-base",
        options.approved_runtime_base,
        "--lifecycle-reference",
        options.lifecycle_reference ??
          `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
        "--sale-correlation-id",
        saleCorrelationId,
        ...serialEndpointArgs,
        "--start-only",
        "--out",
        plan.artifacts.serialPrestartReport,
      ],
      "serial conformance prestart",
      { env: nonQueryEnvironment },
    );
    await run(plan.fixtureCommand, "simulated hardware fixture", {
      env: nonQueryEnvironment,
    });
    // Bring-up applies the fixture's machine profile and can restart device
    // runtimes. Prove the production serial path is ready after that change,
    // immediately before the customer journey begins.
    runRemote(remote, buildInstalledKioskSerialActivationScript());
    launch = runRemote(remote, buildInstalledKioskSaleLaunchScript());
    if (
      launch?.prelaunch?.principal == null ||
      launch.prelaunch.sessionId !== runtime.sessionId ||
      launch.prelaunch.executablePath !== MACHINE_PATH ||
      !String(launch.prelaunch.principal).endsWith("\\VEMKiosk") ||
      typeof launch?.debugTarget?.id !== "string"
    ) {
      throw new Error(
        "temporary CDP launch did not preserve the active VEMKiosk process binding",
      );
    }
    const attestation = {
      targetId: launch.debugTarget.id,
      machine: launch.machine,
    };
    const platformRawQuery = (out) => [
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
    // This must precede the first customer activation, including checkout submit.
    await run(
      platformRawQuery(plan.artifacts.platformRawBaselineReport),
      "authoritative platform raw baseline query",
      { env: queryEnvironment },
    );
    let payment;
    let serial;
    let completion;
    let fulfillmentProbe;
    let fulfillmentProbeError;
    const scenario = await drive({
      tunnelOptions: {
        remote: remote.remote,
        sshPort: remote.sshPort,
        identityFile: remote.identity,
        certificateFile: remote.certificate,
        sshKnownHostsPath: remote.sshKnownHostsPath,
        sshHostKeyAlias: remote.sshHostKeyAlias,
        sshArgs: ["-o", "ProxyCommand=none"],
        remoteCdpPort: 9222,
      },
      expectedRuntimeAttestation: attestation,
      expectedInitialRoute: runtime.route,
      sequenceName: `installed-kiosk-${options.profile}`,
      screenshotCheckpoints: true,
      continuousCapture: true,
      steps: buildInstalledKioskSaleScenarioSteps(options.profile),
      onPaymentWindow: async () => {
        payment = await capture({
          options: remote,
          attestation,
          selector: "[data-installed-kiosk-sale-payment-surface]",
          route: /^#\/payment/,
        });
        const binding = {
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          orderNo: payment.orderNo,
          scenarioSha256: createHash("sha256")
            .update(`${options.run_id}:${payment.paymentId}`)
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
          "scripts/testbed/vm-host-adapter-serial-conformance.mjs",
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
          "--approved-runtime-base",
          options.approved_runtime_base,
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
        if (
          options.maintenance_endpoint_policy_json &&
          !options.maintenance_relay_session_json
        ) {
          throw new Error(
            "--maintenance-endpoint-policy-json requires --maintenance-relay-session-json",
          );
        }
        serialCommand.splice(
          serialCommand.indexOf("--out"),
          0,
          ...serialEndpointArgs,
        );
        restoreConsumedSerialInputs(scanner, trust);
        await run(serialCommand, "serial conformance", {
          env: nonQueryEnvironment,
        });
        serial = JSON.parse(readFileSync(plan.artifacts.serialReport, "utf8"));
        completion = JSON.parse(
          readFileSync(plan.artifacts.completionReport, "utf8"),
        );
        try {
          fulfillmentProbe = await capture({
            options: remote,
            attestation,
            selector:
              "[data-installed-kiosk-sale-fulfillment-surface], [data-installed-kiosk-sale-result-surface]",
            route: /^#\/(dispensing|result)/,
          });
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
    writeJson(plan.artifacts.scenarioReport, scenario);
    const projectedMovementId =
      completion?.simulatedHardwareSaleFlow?.platformState
        ?.postSaleDispenseMovement?.movementId;
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
    );
    const platformRawPost = JSON.parse(
      readFileSync(plan.artifacts.platformRawRecordsReport, "utf8"),
    );
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
    report = {
      schemaVersion: SCHEMA_VERSION,
      kind: "installed-kiosk-sale-acceptance",
      status: "passed",
      ok: true,
      runId: options.run_id,
      profile: options.profile,
      runtimeBinding: {
        normal: runtime,
        prelaunch: launch.prelaunch,
        debug: {
          targetId: launch.debugTarget.id,
          targetUrl: launch.debugTarget.url,
          machine: launch.machine,
        },
      },
      machineUiCdpScenario: scenario,
      fixture: JSON.parse(readFileSync(plan.artifacts.fixtureReport, "utf8")),
      correlation,
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
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (launch?.prelaunch) {
        cleanup = runRemote(
          remote,
          buildInstalledKioskSaleCleanupScript({
            ...launch.prelaunch,
            expectedRoute: "#/catalog",
          }),
        );
        if (
          cleanup?.daemonRunning !== true ||
          cleanup?.cdpListenerCount !== 1 ||
          cleanup?.normal?.principal !== launch.prelaunch.principal ||
          cleanup?.normal?.sessionId !== launch.prelaunch.sessionId ||
          cleanup?.normal?.machineCount !== 1 ||
          cleanup?.normal?.task?.name !== "VEMMachineUI" ||
          cleanup.normal.task.exists !== true ||
          cleanup.normal.task.enabled !== true ||
          !String(cleanup.normal.task.runAsUser ?? "").endsWith("VEMKiosk") ||
          cleanup.normal.cdpListenerCount !== 1 ||
          cleanup.normal.acceptanceOverlayCdp !== true ||
          cleanup.normal.task.acceptanceOverlayCdp !== true ||
          cleanup.normal.task.launcher !==
            "C:\\VEM\\bringup\\launch-machine-ui-debug.vbs" ||
          !Number.isInteger(cleanup.normal.cdpListenerProcessId) ||
          cleanup.normal.cdpListenerSessionId !== launch.prelaunch.sessionId ||
          cleanup.normal.cdpMachineAncestorProcessId !==
            cleanup.normal.processId ||
          cleanup?.normal?.route !== "#/catalog" ||
          cleanup?.normal?.routeEvidence?.source !== "acceptance_overlay_cdp" ||
          cleanup.normal.routeEvidence.settledRoute !== "#/catalog" ||
          cleanup.normal.routeEvidence.settledWithAcceptanceOverlay !== true ||
          !Array.isArray(cleanup.normal.routeEvidence.allowedInitialRoutes) ||
          !cleanup.normal.routeEvidence.allowedInitialRoutes.includes(
            "#/catalog",
          ) ||
          !cleanup.normal.routeEvidence.allowedInitialRoutes.includes(
            "#/result",
          ) ||
          !cleanup.normal.routeEvidence.allowedInitialRoutes.includes(
            cleanup.normal.routeEvidence.initialRoute,
          )
        ) {
          throw new Error(
            "installed kiosk cleanup did not restore the acceptance-overlay VEMKiosk CDP binding",
          );
        }
      } else {
        cleanup = runRemote(
          remote,
          buildInstalledKioskSaleLaunchFailureRecoveryScript(runtime),
        );
        if (
          cleanup?.recovery !== "launch_failure_normal_task_restart" ||
          cleanup?.normalTask !== "VEMMachineUI" ||
          cleanup?.cdpListenerCount !== 0 ||
          cleanup?.normal?.machineCount !== 1 ||
          cleanup.normal.sessionId !== runtime.sessionId ||
          !String(cleanup.normal.principal ?? "").endsWith("\\VEMKiosk")
        ) {
          throw new Error(
            "installed kiosk launch failure cleanup did not restore normal VEMKiosk ownership",
          );
        }
      }
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "installed kiosk sale and cleanup failed",
      );
    } finally {
      if (scanner.owned) rmSync(scanner.path, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
  report.cleanup = {
    status: "passed",
    normal: cleanup.normal,
  };
  writeJson(options.out, report);
  return report;
}

export function formatInstalledKioskSaleError(error) {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.map(
        (cause, index) =>
          `cause ${index + 1}: ${formatInstalledKioskSaleError(cause)}`,
      ),
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  console.error(
    `Usage: VEM_INSTALLED_KIOSK_SALE_DATABASE_URL=... installed-kiosk-sale-acceptance.mjs --run-id ID --machine-code CODE --platform-target TARGET --ephemeral-platform-evidence PATH --runtime-acceptance-report PATH (--remote USER@HOST | --factory-guest-endpoint-json JSON --expected-testbed-user USER) --identity KEY --certificate CERT --adapter PATH --target-identity ID --approved-runtime-base factory-cas://sha256/HASH [--scanner-code-file PATH] [--profile vm-normal|vm-route-competition|factory-route-competition] --out PATH [--dry-run]`,
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
