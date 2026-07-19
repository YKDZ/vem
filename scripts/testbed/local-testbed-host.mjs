#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import {
  recoverHeadlessVncActivator,
  startHeadlessVncActivator,
  VNC_ACTIVATOR_METADATA_FILE,
} from "./kvm-baseline/linux-kvm-baseline.mjs";

const PORTRAIT_WIDTH_PX = 1080;
const PORTRAIT_HEIGHT_PX = 1920;
const DISPLAY_PROOF_SCHEMA = "vem-local-testbed-display-admission-proof/v1";
const ACTIVATOR_SERVICE_OWNER_SCHEMA =
  "vem-local-testbed-headless-vnc-activator-owner/v1";
const RUNNER_ADMISSION_TIMEOUT_SECONDS = 180;
const DOMAIN_ACPI_SHUTDOWN_TIMEOUT_MS = 20_000;
const DOMAIN_ACPI_SHUTDOWN_POLL_MS = 1_000;

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function absolute(value, label) {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function optionalOptionOrEmpty(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("host lifecycle configuration is required");
  }
  const hostPrivateCidr = required(config.hostPrivateCidr, "hostPrivateCidr");
  const [hostAddress, prefix, ...extra] = hostPrivateCidr.split("/");
  if (
    extra.length !== 0 ||
    isIP(hostAddress) !== 4 ||
    !/^\d+$/.test(prefix ?? "") ||
    Number(prefix) < 0 ||
    Number(prefix) > 32
  ) {
    throw new Error("hostPrivateCidr must be an IPv4 CIDR");
  }
  const validated = {
    libvirtUri: required(config.libvirtUri, "libvirtUri"),
    domainName: required(config.domainName, "domainName"),
    overlayPath: absolute(config.overlayPath, "overlayPath"),
    runtimeXmlPath: absolute(config.runtimeXmlPath, "runtimeXmlPath"),
    admissionFilterName: required(
      config.admissionFilterName,
      "admissionFilterName",
    ),
    admissionFilterXmlPath: absolute(
      config.admissionFilterXmlPath,
      "admissionFilterXmlPath",
    ),
    hostPrivateCidr,
    ssh: {
      host: required(config.ssh?.host, "ssh.host"),
      port: positiveInteger(config.ssh?.port, "ssh.port"),
      user: required(config.ssh?.user, "ssh.user"),
      identityFile: absolute(config.ssh?.identityFile, "ssh.identityFile"),
      knownHostsFile: absolute(
        config.ssh?.knownHostsFile,
        "ssh.knownHostsFile",
      ),
      readinessTimeoutSeconds: positiveInteger(
        config.ssh?.readinessTimeoutSeconds,
        "ssh.readinessTimeoutSeconds",
      ),
    },
  };
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(validated.domainName)) {
    throw new Error("domainName contains unsupported characters");
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(validated.admissionFilterName)) {
    throw new Error("admissionFilterName contains unsupported characters");
  }
  return validated;
}

function virsh(config, operation, ...args) {
  return {
    command: "virsh",
    args: ["--connect", config.libvirtUri, operation, ...args],
  };
}

function sshArgs(config, remoteCommand) {
  return [
    "-p",
    String(config.ssh.port),
    "-i",
    config.ssh.identityFile,
    "-o",
    `UserKnownHostsFile=${config.ssh.knownHostsFile}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    `${config.ssh.user}@${config.ssh.host}`,
    remoteCommand,
  ];
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedPowerShellCommand(script) {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function compressedPowerShellCommand(script) {
  const payload = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const bootstrap = `$b=[Convert]::FromBase64String('${payload}');$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g);try{& ([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$g.Dispose();$m.Dispose()}`;
  return encodedPowerShellCommand(bootstrap);
}

function guestInputAssertion(path, runId) {
  return `$ErrorActionPreference = 'Stop'
$path = ${quotePowerShell(path)}
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'guest input is not staged' }
$guestDocument = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
if ($guestDocument.schemaVersion -ne 'vem-local-testbed-guest-input/v1') { throw 'guest input schema is invalid' }
if ($guestDocument.runId -ne ${quotePowerShell(runId)}) { throw 'guest input run does not match' }
`;
}

function interactiveDisplayAssertion(expectedUser, width, height) {
  return `$ErrorActionPreference = 'Stop'
function Convert-QuserSessionLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  $match = [regex]::Match($Line, '^\\s*>?\\s*(?<user>\\S+)\\s+(?:(?<sessionName>\\S+)\\s+)?(?<id>\\d+)\\s+(?<state>\\S+)')
  if (-not $match.Success) { return $null }
  $user = [string]$match.Groups["user"].Value
  if ($user.Contains('\\')) { $user = $user.Split('\\')[-1] }
  [pscustomobject]@{
    user = $user
    sessionName = if ($match.Groups["sessionName"].Success) { [string]$match.Groups["sessionName"].Value } else { $null }
    sessionId = [int]$match.Groups["id"].Value
    state = [string]$match.Groups["state"].Value
  }
}

function Test-ExpectedInteractiveSession($Session, [string]$User) {
  if ($null -eq $Session) { return $false }
  $state = ([string]$Session.state).Trim().ToLowerInvariant()
  $sessionName = ([string]$Session.sessionName).Trim().ToLowerInvariant()
  return (
    [string]$Session.user -ieq $User -and
    ($state -eq 'active' -or (
      $sessionName -eq 'console' -and
      $state -ne 'disc' -and
      $state -ne 'disconnected' -and
      $state -ne 'listen'
    ))
  )
}
$expectedUser = ${quotePowerShell(expectedUser)}
$lines = @(quser 2>$null | Select-Object -Skip 1)
$sessions = @($lines | ForEach-Object { Convert-QuserSessionLine ([string]$_) } | Where-Object { $null -ne $_ })
$session = @($sessions | Where-Object { Test-ExpectedInteractiveSession $_ $expectedUser } | Select-Object -First 1)
if ($session.Count -eq 0) { throw "interactive session for $expectedUser was not observed" }
$displayReportPath = 'C:\\ProgramData\\WindowsRuntimeBaseline\\interactive-display-report.json'
if (-not (Test-Path -LiteralPath $displayReportPath -PathType Leaf)) { throw 'interactive display report was not found' }
$displayReport = Get-Content -LiteralPath $displayReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
$screen = [pscustomobject]@{
  widthPx = [int]$displayReport.desktop.width
  heightPx = [int]$displayReport.desktop.height
  source = 'interactive_autologon_report'
}
$proof = [ordered]@{
  schemaVersion = ${quotePowerShell(DISPLAY_PROOF_SCHEMA)}
  status = if ($screen.widthPx -eq ${width} -and $screen.heightPx -eq ${height}) { 'passed' } else { 'failed' }
  expectedWidthPx = ${width}
  expectedHeightPx = ${height}
  widthPx = [int]$screen.widthPx
  heightPx = [int]$screen.heightPx
  sessionUser = [string]$session[0].user
  sessionId = [int]$session[0].sessionId
  source = [string]$screen.source
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
}
if ($proof.status -ne 'passed') {
  throw ('interactive desktop display baseline is {0}x{1}, expected ${width}x${height}' -f $proof.widthPx, $proof.heightPx)
}
$proof | ConvertTo-Json -Compress
`;
}

function runnerAdmissionAssertion(
  runnerProxy,
  runnerRegistrationToken,
  runnerRemovalToken,
  runId,
) {
  const hostTimeUnixSeconds = Math.floor(Date.now() / 1000);
  const runnerName = `forest-win10-runtime-${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const registrationSetup = runnerRegistrationToken
    ? `$oldServiceIdentityPath = Join-Path $runnerRoot '.service'
if (Test-Path -LiteralPath $oldServiceIdentityPath -PathType Leaf) {
  $oldServiceName = (Get-Content -LiteralPath $oldServiceIdentityPath -Raw -Encoding UTF8).Trim()
  if ($oldServiceName -like 'actions.runner.*') {
    Stop-Service -Name $oldServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $oldServiceName | Out-Null
  }
}
Set-RunnerAdmissionPhase 'removed-old-runner'
$runnerIdentityFiles = @('.runner', '.credentials', '.credentials_rsaparams', '.service')
$runnerIdentityFiles | ForEach-Object { Remove-Item -LiteralPath (Join-Path $runnerRoot $_) -Force -ErrorAction SilentlyContinue }
$runnerWorkRoot = 'D:\\runtime-cache\\v1\\actions-work'
New-Item -ItemType Directory -Force -Path $runnerWorkRoot | Out-Null
$env:GITHUB_ACTIONS_RUNNER_TLS_NO_VERIFY = '1'
Add-Content -LiteralPath $environmentPath -Value 'GITHUB_ACTIONS_RUNNER_TLS_NO_VERIFY=1'
& (Join-Path $runnerRoot 'config.cmd') --unattended --url 'https://github.com/YKDZ/vem' --token ${quotePowerShell(runnerRegistrationToken)} --name ${quotePowerShell(runnerName)} --labels 'vem-runtime' --work $runnerWorkRoot --runasservice --windowslogonaccount 'NT AUTHORITY\\NETWORK SERVICE' --replace
if ($LASTEXITCODE -ne 0) { throw "actions runner dynamic registration failed with exit code $LASTEXITCODE" }
Set-RunnerAdmissionPhase 'configured-new-runner'
$registeredRunner = Get-Content -LiteralPath (Join-Path $runnerRoot '.runner') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$registeredRunner.agentName -ne ${quotePowerShell(runnerName)}) { throw "actions runner registered unexpected identity: $($registeredRunner.agentName)" }
`
    : "";
  const proxyLines = runnerProxy?.configured
    ? [
        `HTTP_PROXY=${runnerProxy.http}`,
        `HTTPS_PROXY=${runnerProxy.https}`,
        `NO_PROXY=${runnerProxy.noProxy}`,
      ].filter((line) => !line.endsWith("="))
    : [];
  const proxyEnvironmentAssignments = runnerProxy?.configured
    ? [
        ["HTTP_PROXY", runnerProxy.http],
        ["HTTPS_PROXY", runnerProxy.https],
        ["NO_PROXY", runnerProxy.noProxy],
      ]
        .map(
          ([name, value]) => `$env:${name} = ${quotePowerShell(value ?? "")}`,
        )
        .join("\n")
    : "";
  const updateEnvironment = runnerProxy?.configured
    ? `$proxyLines = @(${proxyLines.map(quotePowerShell).join(", ")})
$existingLines = if (Test-Path -LiteralPath $environmentPath -PathType Leaf) { @(Get-Content -LiteralPath $environmentPath -Encoding UTF8) } else { @() }
$preservedLines = @($existingLines | Where-Object { $_ -notmatch '^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=' })
[System.IO.File]::WriteAllLines($environmentPath, @($preservedLines + $proxyLines), [System.Text.UTF8Encoding]::new($false))
${proxyEnvironmentAssignments}
`
    : "";
  return `$ErrorActionPreference = 'Stop'
$runnerRoot = 'C:\\actions-runner'
$environmentPath = 'C:\\actions-runner\\.env'
$serviceIdentityPath = Join-Path $runnerRoot '.service'
$phasePath = 'C:\\ProgramData\\VEM\\testbed\\runner-admission-phase.txt'
function Set-RunnerAdmissionPhase([string]$Phase) { [System.IO.File]::WriteAllText($phasePath, $Phase, [System.Text.UTF8Encoding]::new($false)) }
Set-RunnerAdmissionPhase 'started'
Set-Date -Date ([DateTimeOffset]::FromUnixTimeSeconds(${hostTimeUnixSeconds}).LocalDateTime)
${updateEnvironment}${registrationSetup}Set-RunnerAdmissionPhase 'identity-ready'
if (-not (Test-Path -LiteralPath $serviceIdentityPath -PathType Leaf)) { throw 'actions runner service identity is unavailable' }
$serviceName = (Get-Content -LiteralPath $serviceIdentityPath -Raw -Encoding UTF8).Trim()
if ($serviceName -notlike 'actions.runner.*') { throw 'actions runner service identity is invalid' }
$service = Get-Service -Name $serviceName -ErrorAction Stop
Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
& sc.exe config $service.Name obj= LocalSystem | Out-Null
if ($LASTEXITCODE -ne 0) { throw "actions runner LocalSystem configuration failed with exit code $LASTEXITCODE" }
Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$diagnosticDirectory = Join-Path $runnerRoot '_diag'
$diagnosticOffsets = @{}
@(Get-ChildItem -LiteralPath $diagnosticDirectory -Filter 'Runner_*.log' -File -ErrorAction SilentlyContinue) | ForEach-Object { $diagnosticOffsets[$_.FullName] = [int64]$_.Length }
Restart-Service -Name $service.Name -Force -ErrorAction Stop
$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
Set-RunnerAdmissionPhase 'waiting-listener'
$deadline = (Get-Date).ToUniversalTime().AddSeconds(${RUNNER_ADMISSION_TIMEOUT_SECONDS})
$latestTail = ''
while ((Get-Date).ToUniversalTime() -lt $deadline) {
  $logs = @(Get-ChildItem -LiteralPath $diagnosticDirectory -Filter 'Runner_*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
  foreach ($log in $logs) {
    $offset = if ($diagnosticOffsets.ContainsKey($log.FullName)) { [int64]$diagnosticOffsets[$log.FullName] } else { 0 }
    if ([int64]$log.Length -lt $offset) { $offset = 0 }
    $stream = [System.IO.File]::Open($log.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
      $reader = [System.IO.StreamReader]::new($stream)
      try { $tail = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    if (-not [string]::IsNullOrWhiteSpace($tail)) { $latestTail = $tail }
    $marker = [regex]::Match($tail, 'Listening for Jobs|Runner reconnected')
    if ($marker.Success) {
      Set-RunnerAdmissionPhase 'listener-ready'
      [ordered]@{ serviceName = $service.Name; listenerMarker = $marker.Value; diagnosticLog = $log.Name; diagnosticOffset = $offset } | ConvertTo-Json -Compress
      exit 0
    }
  }
  Start-Sleep -Seconds 2
}
$serviceState = (Get-Service -Name $service.Name -ErrorAction SilentlyContinue).Status
throw ("actions runner did not report a fresh listener diagnostic within ${RUNNER_ADMISSION_TIMEOUT_SECONDS} seconds (service=$serviceState; latest diagnostic tail: $latestTail)")
`;
}

function parseJsonLine(stdout, label) {
  const trimmed = String(stdout ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} did not emit JSON`);
  }
  const lastLine = trimmed.split(/\r?\n/).at(-1);
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new Error(`${label} emitted malformed JSON`);
  }
}

function validateDisplayAdmissionProof(
  proof,
  { expectedUser, width = PORTRAIT_WIDTH_PX, height = PORTRAIT_HEIGHT_PX } = {},
) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error("interactive display admission proof is invalid");
  }
  if (
    proof.schemaVersion !== DISPLAY_PROOF_SCHEMA ||
    proof.status !== "passed" ||
    proof.widthPx !== width ||
    proof.heightPx !== height ||
    String(proof.sessionUser ?? "").toLowerCase() !==
      String(expectedUser).toLowerCase()
  ) {
    throw new Error(
      `interactive display admission proof must pass at exactly ${width}x${height} for ${expectedUser}`,
    );
  }
  return proof;
}

function headlessVncActivatorOwner(stateRoot, domainName) {
  const systemStagingPath = absolute(stateRoot, "stateRoot");
  return {
    schemaVersion: ACTIVATOR_SERVICE_OWNER_SCHEMA,
    purpose: "local-testbed-runtime",
    domainName: required(domainName, "domainName"),
    systemStagingPath: join(systemStagingPath, "headless-vnc-activator"),
  };
}

export function renderAdmissionFilterXml(configInput, admitted = false) {
  const config = validateConfig(configInput);
  if (admitted) {
    return `<filter name="${xml(config.admissionFilterName)}" chain="root">
  <rule action="accept" direction="inout" priority="100"><all/></rule>
</filter>
`;
  }
  const [hostAddress, prefix] = config.hostPrivateCidr.split("/");
  return `<filter name="${xml(config.admissionFilterName)}" chain="root">
  <rule action="accept" direction="inout" priority="100"><mac protocolid="arp"/></rule>
  <rule action="accept" direction="out" priority="200"><udp srcportstart="68" srcportend="68" dstportstart="67" dstportend="67"/></rule>
  <rule action="accept" direction="in" priority="210"><udp srcportstart="67" srcportend="67" dstportstart="68" dstportend="68"/></rule>
  <rule action="accept" direction="out" priority="300"><ip dstipaddr="${xml(hostAddress)}" dstipmask="${xml(prefix)}"/></rule>
  <rule action="accept" direction="in" priority="310"><ip srcipaddr="${xml(hostAddress)}" srcipmask="${xml(prefix)}"/></rule>
  <rule action="drop" direction="out" priority="900"><all/></rule>
  <rule action="accept" direction="in" priority="910"><all/></rule>
</filter>
`;
}

function countLiteral(value, needle) {
  return value.split(needle).length - 1;
}

export function runtimeAudioCapturePath(domainXml) {
  const devices = [
    ...String(domainXml).matchAll(/<audio\b[^>]*\btype="file"[^>]*\/?\s*>/g),
  ];
  if (devices.length !== 1) {
    throw new Error(
      "runtime domain must contain exactly one file audio output",
    );
  }
  const path = devices[0][0].match(/\bpath="([^"]+)"/)?.[1];
  return absolute(path, "runtime audio capture path");
}

export async function prepareRuntimeAudioCapture(domainXml) {
  const path = runtimeAudioCapturePath(domainXml);
  await writeFile(path, "", { mode: 0o666 });
  await chmod(path, 0o666);
  return path;
}

export function renderReconstructedDomainXml({
  templateXml,
  config: configInput,
  baselineSystem,
  cacheDisk,
}) {
  const config = validateConfig(configInput);
  const baseline = absolute(baselineSystem, "baselineSystem");
  const cache = absolute(cacheDisk, "cacheDisk");
  if (new Set([baseline, cache, config.overlayPath]).size !== 3) {
    throw new Error(
      "baseline C, overlay C, and persistent D paths must differ",
    );
  }
  const domainNames = [...templateXml.matchAll(/<name>[^<]+<\/name>/g)];
  if (domainNames.length !== 1) {
    throw new Error(
      "published domain XML must contain exactly one domain name",
    );
  }
  const baselineSource = `file="${xml(baseline)}"`;
  const cacheSource = `file="${xml(cache)}"`;
  if (
    countLiteral(templateXml, baselineSource) !== 1 ||
    countLiteral(templateXml, cacheSource) !== 1
  ) {
    throw new Error(
      "published domain XML must reference baseline C and persistent D exactly once",
    );
  }
  let rendered = templateXml.replace(/\s*<seclabel\b[^>]*\/?\s*>/g, "");
  rendered = rendered.replace(
    domainNames[0][0],
    `<name>${xml(config.domainName)}</name>\n  <seclabel type="none"/>`,
  );
  rendered = rendered.replace(/\s*<uuid>[^<]+<\/uuid>/, "");
  rendered = rendered.replace(
    baselineSource,
    `file="${xml(config.overlayPath)}"`,
  );
  const interfaces = [
    ...rendered.matchAll(/<interface\b[^>]*>[\s\S]*?<\/interface>/g),
  ];
  if (interfaces.length !== 1 || /<filterref\b/.test(interfaces[0][0])) {
    throw new Error(
      "published domain XML must have one unfiltered network interface",
    );
  }
  return rendered;
}

export function buildHostReconstructionPlan({
  config: configInput,
  runId,
  baselineSystem,
  cacheDisk,
  domainXml,
}) {
  const config = validateConfig(configInput);
  required(runId, "runId");
  const baseline = absolute(baselineSystem, "baselineSystem");
  const cache = absolute(cacheDisk, "cacheDisk");
  const template = absolute(domainXml, "domainXml");
  const pendingOverlay = `${config.overlayPath}.pending`;
  return [
    {
      type: "acpi-shutdown-domain",
      ...virsh(config, "shutdown", config.domainName),
    },
    { type: "destroy-domain", ...virsh(config, "destroy", config.domainName) },
    {
      type: "undefine-domain",
      ...virsh(config, "undefine", config.domainName),
    },
    { type: "remove-file", path: config.overlayPath },
    { type: "remove-file", path: pendingOverlay },
    {
      type: "create-overlay",
      command: "qemu-img",
      args: [
        "create",
        "-f",
        "qcow2",
        "-F",
        "qcow2",
        "-b",
        baseline,
        pendingOverlay,
      ],
    },
    { type: "publish-overlay", from: pendingOverlay, to: config.overlayPath },
    {
      type: "write-runtime-domain",
      path: config.runtimeXmlPath,
      template,
      baselineSystem: baseline,
      cacheDisk: cache,
    },
    {
      type: "define-domain",
      ...virsh(config, "define", config.runtimeXmlPath),
    },
    { type: "start-domain", ...virsh(config, "start", config.domainName) },
    { type: "wait-ssh", timeoutSeconds: config.ssh.readinessTimeoutSeconds },
  ];
}

function domainIsShutOff(state) {
  return (
    String(state ?? "")
      .trim()
      .toLowerCase() === "shut off"
  );
}

export async function stopDomainBeforeReconstruction(
  config,
  {
    domainDefined,
    runCommand = run,
    runCaptureCommand = runCapture,
    sleep = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    now = Date.now,
  } = {},
) {
  if (!domainDefined) return { stoppedBy: "absent" };
  const stateCommand = virsh(config, "domstate", config.domainName);
  const initialState = await runCaptureCommand(
    stateCommand.command,
    stateCommand.args,
  );
  if (domainIsShutOff(initialState.stdout)) return { stoppedBy: "shut-off" };

  const shutdownCommand = virsh(config, "shutdown", config.domainName);
  await runCommand(shutdownCommand.command, shutdownCommand.args);
  const deadline = now() + DOMAIN_ACPI_SHUTDOWN_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(DOMAIN_ACPI_SHUTDOWN_POLL_MS);
    const state = await runCaptureCommand(
      stateCommand.command,
      stateCommand.args,
    );
    if (domainIsShutOff(state.stdout)) return { stoppedBy: "acpi" };
  }
  const destroyCommand = virsh(config, "destroy", config.domainName);
  await runCommand(destroyCommand.command, destroyCommand.args);
  return { stoppedBy: "destroy" };
}

export function buildHostAdmissionPlan({
  config: configInput,
  guestInputPath,
  runId,
  runnerProxy = { configured: false },
  runnerRegistrationToken = null,
  runnerRemovalToken = null,
}) {
  const config = validateConfig(configInput);
  const path = windowsAbsolute(guestInputPath, "guestInputPath");
  const expectedRunId = required(runId, "runId");
  const assertion = guestInputAssertion(path, expectedRunId);
  const displayAssertion = interactiveDisplayAssertion(
    config.ssh.user,
    PORTRAIT_WIDTH_PX,
    PORTRAIT_HEIGHT_PX,
  );
  const runnerAssertion = runnerAdmissionAssertion(
    runnerProxy,
    runnerRegistrationToken,
    runnerRemovalToken,
    expectedRunId,
  );
  return [
    {
      type: "assert-guest-input",
      path,
      command: "ssh",
      args: sshArgs(config, encodedPowerShellCommand(assertion)),
      encodedPowerShell: true,
      input: assertion,
    },
    {
      type: "assert-interactive-display",
      command: "ssh",
      expectedUser: config.ssh.user,
      expectedWidth: PORTRAIT_WIDTH_PX,
      expectedHeight: PORTRAIT_HEIGHT_PX,
      args: sshArgs(config, encodedPowerShellCommand(displayAssertion)),
      encodedPowerShell: true,
      input: displayAssertion,
    },
    {
      type: "restart-runner-and-await-listener",
      command: "ssh",
      args: sshArgs(config, compressedPowerShellCommand(runnerAssertion)),
      encodedPowerShell: true,
      input: runnerAssertion,
    },
  ];
}

function run(command, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    if (input !== undefined) child.stdin.end(input);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? "signal"}`));
    });
  });
}

function runCapture(command, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} exited with ${code ?? "signal"}: ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

async function waitForSsh(config) {
  const deadline = Date.now() + config.ssh.readinessTimeoutSeconds * 1_000;
  const command = 'powershell -NoProfile -NonInteractive -Command "exit 0"';
  while (Date.now() < deadline) {
    try {
      await runCapture("ssh", sshArgs(config, command));
      return;
    } catch {
      const state = await runCapture("virsh", [
        "--connect",
        config.libvirtUri,
        "domstate",
        config.domainName,
      ]).catch(() => null);
      if (state && state.stdout.trim().toLowerCase() !== "running") {
        throw new Error(
          `guest stopped while waiting for SSH: ${state.stdout.trim()}`,
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
  }
  throw new Error(
    `guest SSH did not become ready within ${config.ssh.readinessTimeoutSeconds} seconds`,
  );
}

async function executeReconstruction(options) {
  const config = options.config;
  await Promise.all([
    access(options.baselineSystem),
    access(options.cacheDisk),
    access(options.domainXml),
    access(config.ssh.identityFile),
    access(config.ssh.knownHostsFile),
  ]);
  const templateXml = await readFile(options.domainXml, "utf8");
  const runtimeXml = renderReconstructedDomainXml({
    templateXml,
    config,
    baselineSystem: options.baselineSystem,
    cacheDisk: options.cacheDisk,
  });
  const plan = buildHostReconstructionPlan(options);
  await Promise.all([
    mkdir(dirname(config.overlayPath), { recursive: true }),
    mkdir(dirname(config.runtimeXmlPath), { recursive: true }),
    mkdir(dirname(config.admissionFilterXmlPath), { recursive: true }),
  ]);
  const definedDomains = await runCapture("virsh", [
    "--connect",
    config.libvirtUri,
    "list",
    "--all",
    "--name",
  ]);
  const domainDefined = definedDomains.stdout
    .split(/\r?\n/)
    .some((name) => name.trim() === config.domainName);
  for (const step of plan) {
    if (step.type === "acpi-shutdown-domain") {
      await stopDomainBeforeReconstruction(config, { domainDefined });
    } else if (step.type === "destroy-domain") {
      continue;
    } else if (step.type === "undefine-domain") {
      if (domainDefined) await run(step.command, step.args);
    } else if (step.type === "remove-file") {
      await rm(step.path, { force: true });
    } else if (step.type === "create-overlay") {
      await run(step.command, step.args);
    } else if (step.type === "publish-overlay") {
      await rename(step.from, step.to);
    } else if (step.type === "write-runtime-domain") {
      await prepareRuntimeAudioCapture(runtimeXml);
      await writeFile(step.path, runtimeXml, "utf8");
    } else if (step.type === "wait-ssh") {
      await waitForSsh(config);
    } else {
      await run(step.command, step.args);
    }
  }
  return {
    action: "reconstruct",
    runId: options.runId,
    domainName: config.domainName,
    overlayPath: config.overlayPath,
    cacheDisk: options.cacheDisk,
    runnerAdmitted: false,
  };
}

async function executeAdmission(options) {
  const plan = buildHostAdmissionPlan(options);
  const { displayAdmissionProof, runnerAdmission } =
    await executeHostAdmissionPlan(plan);
  return {
    action: "admit",
    runId: options.runId,
    domainName: options.config.domainName,
    guestInputPath: options.guestInputPath,
    runnerAdmitted: true,
    displayAdmissionProof,
    runnerAdmission,
  };
}

export async function executeHostAdmissionPlan(
  plan,
  { runCommand = run, runCaptureCommand = runCapture } = {},
) {
  let displayAdmissionProof = null;
  let runnerAdmission = null;
  for (const step of plan) {
    if (step.type === "assert-interactive-display") {
      const output = await runCaptureCommand(
        step.command,
        step.args,
        step.encodedPowerShell ? undefined : step.input,
        step.input,
      );
      displayAdmissionProof = validateDisplayAdmissionProof(
        parseJsonLine(output.stdout, "interactive display admission proof"),
        {
          expectedUser: step.expectedUser,
          width: step.expectedWidth,
          height: step.expectedHeight,
        },
      );
    } else if (step.type === "restart-runner-and-await-listener") {
      const output = await runCaptureCommand(
        step.command,
        step.args,
        step.encodedPowerShell ? undefined : step.input,
        step.input,
      );
      runnerAdmission = parseJsonLine(output.stdout, "runner admission");
      if (
        typeof runnerAdmission.serviceName !== "string" ||
        typeof runnerAdmission.listenerMarker !== "string" ||
        typeof runnerAdmission.diagnosticLog !== "string"
      ) {
        throw new Error("runner admission emitted incomplete diagnostics");
      }
      if (
        !["Listening for Jobs", "Runner reconnected"].includes(
          runnerAdmission.listenerMarker,
        )
      ) {
        throw new Error("runner admission emitted an invalid listener marker");
      }
    } else {
      await runCommand(
        step.command,
        step.args,
        step.encodedPowerShell ? undefined : step.input,
        step.input,
      );
    }
  }
  return { displayAdmissionProof, runnerAdmission };
}

export function parseHostOptions(args) {
  const action = args[0];
  if (
    action !== "reconstruct" &&
    action !== "admit" &&
    action !== "headless-vnc-activator"
  ) {
    throw new Error(
      "action must be reconstruct, admit, or headless-vnc-activator",
    );
  }
  if (action === "headless-vnc-activator") {
    return {
      action,
      libvirtUri: required(option(args, "libvirt-uri"), "libvirtUri"),
      domainName: required(option(args, "domain-name"), "domainName"),
      stateRoot: absolute(option(args, "state-root"), "stateRoot"),
    };
  }
  const config = validateConfig({
    libvirtUri: option(args, "libvirt-uri"),
    domainName: option(args, "domain-name"),
    overlayPath: option(args, "overlay"),
    runtimeXmlPath: option(args, "runtime-xml"),
    admissionFilterName: option(args, "filter-name"),
    admissionFilterXmlPath: option(args, "filter-xml"),
    hostPrivateCidr: option(args, "host-private-cidr"),
    ssh: {
      host: option(args, "ssh-host"),
      port: option(args, "ssh-port"),
      user: option(args, "ssh-user"),
      identityFile: option(args, "identity-file"),
      knownHostsFile: option(args, "known-hosts-file"),
      readinessTimeoutSeconds: option(args, "readiness-timeout-seconds"),
    },
  });
  const common = {
    action,
    config,
    runId: required(option(args, "run-id"), "runId"),
  };
  if (action === "admit") {
    const runnerProxyConfigured = args.includes("--runner-proxy-configured");
    return {
      ...common,
      guestInputPath: windowsAbsolute(
        option(args, "guest-input"),
        "guestInputPath",
      ),
      runnerProxy: runnerProxyConfigured
        ? {
            configured: true,
            http: optionalOptionOrEmpty(args, "runner-http-proxy") ?? "",
            https: optionalOptionOrEmpty(args, "runner-https-proxy") ?? "",
            noProxy: optionalOptionOrEmpty(args, "runner-no-proxy") ?? "",
          }
        : { configured: false },
      runnerRegistrationToken: option(args, "runner-registration-token"),
      runnerRemovalToken: option(args, "runner-removal-token"),
    };
  }
  return {
    ...common,
    baselineSystem: absolute(option(args, "baseline-system"), "baselineSystem"),
    cacheDisk: absolute(option(args, "cache-disk"), "cacheDisk"),
    domainXml: absolute(option(args, "domain-xml"), "domainXml"),
  };
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const completion = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? "signal"}`));
    });
  });
  return { child, completion };
}

async function executeHeadlessVncActivatorService(options) {
  const owner = headlessVncActivatorOwner(
    options.stateRoot,
    options.domainName,
  );
  const metadataPath = join(
    owner.systemStagingPath,
    VNC_ACTIVATOR_METADATA_FILE,
  );
  await mkdir(owner.systemStagingPath, { recursive: true });
  const recovered = await recoverHeadlessVncActivator({
    metadataPath,
    owner,
  });
  if (!recovered.recovered) {
    throw new Error("headless VNC activator metadata could not be recovered");
  }
  await rm(owner.systemStagingPath, { recursive: true, force: true });
  await mkdir(owner.systemStagingPath, { recursive: true });
  let stopping = false;
  let resolveStop;
  const stopSignal = new Promise((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const onSignal = () => {
    stopping = true;
    resolveStop();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, onSignal);
  }
  let activator;
  try {
    activator = await startHeadlessVncActivator({
      domainName: options.domainName,
      libvirtUri: options.libvirtUri,
      metadataPath,
      owner,
      runCommand: runCapture,
      startProcess,
      commands: {
        width: PORTRAIT_WIDTH_PX,
        height: PORTRAIT_HEIGHT_PX,
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        action: "headless-vnc-activator",
        domainName: options.domainName,
        endpoint: activator.endpoint,
        owner,
      })}\n`,
    );
    await Promise.race([
      stopSignal,
      activator.failure.then((error) => {
        throw error;
      }),
    ]);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.removeListener(signal, onSignal);
    }
    if (activator) {
      await activator.stop().catch((error) => {
        if (!stopping) throw error;
      });
    }
    await rm(owner.systemStagingPath, { recursive: true, force: true });
  }
  return {
    action: "headless-vnc-activator",
    domainName: options.domainName,
    stopped: true,
  };
}

async function main() {
  const options = parseHostOptions(process.argv.slice(2));
  const result =
    options.action === "reconstruct"
      ? await executeReconstruction(options)
      : options.action === "admit"
        ? await executeAdmission(options)
        : await executeHeadlessVncActivatorService(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
