#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const POWERSHELL_STDIN_COMMAND =
  'powershell -NoProfile -NonInteractive -Command "$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))"';

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
function Get-CurrentDesktopScreenDimensions {
  if ($null -eq ('VemDisplaySettings' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public struct VemDevMode {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
  public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
  public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
  public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
  public short dmLogPixels;
  public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
}
public static class VemDisplaySettings {
  public const int ENUM_CURRENT_SETTINGS = -1;
  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref VemDevMode devMode);
}
"@ -ErrorAction Stop
  }
  $mode = New-Object VemDevMode
  $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([VemDevMode])
  if (-not [VemDisplaySettings]::EnumDisplaySettings($null, [VemDisplaySettings]::ENUM_CURRENT_SETTINGS, [ref]$mode)) {
    throw 'interactive desktop dimensions were not available'
  }
  [pscustomobject]@{
    widthPx = [int]$mode.dmPelsWidth
    heightPx = [int]$mode.dmPelsHeight
    source = 'enum_display_settings'
  }
}
$expectedUser = ${quotePowerShell(expectedUser)}
$lines = @(quser 2>$null | Select-Object -Skip 1)
$sessions = @($lines | ForEach-Object { Convert-QuserSessionLine ([string]$_) } | Where-Object { $null -ne $_ })
$session = @($sessions | Where-Object { Test-ExpectedInteractiveSession $_ $expectedUser } | Select-Object -First 1)
if ($session.Count -eq 0) { throw "interactive session for $expectedUser was not observed" }
$screen = Get-CurrentDesktopScreenDimensions
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
  let rendered = templateXml.replace(
    domainNames[0][0],
    `<name>${xml(config.domainName)}</name>`,
  );
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

export function buildHostAdmissionPlan({
  config: configInput,
  guestInputPath,
  runId,
}) {
  const config = validateConfig(configInput);
  const path = windowsAbsolute(guestInputPath, "guestInputPath");
  const expectedRunId = required(runId, "runId");
  const assertion = guestInputAssertion(path, expectedRunId);
  return [
    {
      type: "assert-guest-input",
      path,
      command: "ssh",
      args: sshArgs(config, POWERSHELL_STDIN_COMMAND),
      input: assertion,
    },
    {
      type: "assert-interactive-display",
      command: "ssh",
      expectedUser: config.ssh.user,
      expectedWidth: PORTRAIT_WIDTH_PX,
      expectedHeight: PORTRAIT_HEIGHT_PX,
      args: sshArgs(config, POWERSHELL_STDIN_COMMAND),
      input: interactiveDisplayAssertion(
        config.ssh.user,
        PORTRAIT_WIDTH_PX,
        PORTRAIT_HEIGHT_PX,
      ),
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
    if (step.type === "destroy-domain") {
      if (!domainDefined) continue;
      const state = await runCapture("virsh", [
        "--connect",
        config.libvirtUri,
        "domstate",
        config.domainName,
      ]);
      if (state.stdout.trim().toLowerCase() !== "shut off") {
        await run(step.command, step.args);
      }
    } else if (step.type === "undefine-domain") {
      if (domainDefined) await run(step.command, step.args);
    } else if (step.type === "remove-file") {
      await rm(step.path, { force: true });
    } else if (step.type === "create-overlay") {
      await run(step.command, step.args);
    } else if (step.type === "publish-overlay") {
      await rename(step.from, step.to);
    } else if (step.type === "write-runtime-domain") {
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
  const { displayAdmissionProof } = await executeHostAdmissionPlan(plan);
  return {
    action: "admit",
    runId: options.runId,
    domainName: options.config.domainName,
    guestInputPath: options.guestInputPath,
    runnerAdmitted: true,
    displayAdmissionProof,
  };
}

export async function executeHostAdmissionPlan(
  plan,
  { runCommand = run, runCaptureCommand = runCapture } = {},
) {
  let displayAdmissionProof = null;
  for (const step of plan) {
    if (step.type === "assert-interactive-display") {
      const output = await runCaptureCommand(
        step.command,
        step.args,
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
    } else {
      await runCommand(step.command, step.args, step.input);
    }
  }
  return { displayAdmissionProof };
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
    return {
      ...common,
      guestInputPath: windowsAbsolute(
        option(args, "guest-input"),
        "guestInputPath",
      ),
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
