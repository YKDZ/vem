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
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function guestInputAssertion(path, runId) {
  return `$ErrorActionPreference = 'Stop'
$path = ${quotePowerShell(path)}
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'guest input is not staged' }
$input = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if ($input.schemaVersion -ne 'vem-local-testbed-guest-input/v1') { throw 'guest input schema is invalid' }
if ($input.runId -ne ${quotePowerShell(runId)}) { throw 'guest input run does not match' }
`;
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
  const expectedName = `<name>${xml(config.domainName)}</name>`;
  if (countLiteral(templateXml, expectedName) !== 1) {
    throw new Error("published domain XML does not name the configured domain");
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
  const filteredInterface = interfaces[0][0].replace(
    "</interface>",
    `<filterref filter="${xml(config.admissionFilterName)}"/></interface>`,
  );
  rendered = rendered.replace(interfaces[0][0], filteredInterface);
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
      type: "write-admission-gate",
      path: config.admissionFilterXmlPath,
      content: renderAdmissionFilterXml(config),
    },
    {
      type: "write-runtime-domain",
      path: config.runtimeXmlPath,
      template,
      baselineSystem: baseline,
      cacheDisk: cache,
    },
    {
      type: "define-admission-gate",
      ...virsh(config, "nwfilter-define", config.admissionFilterXmlPath),
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
      args: sshArgs(
        config,
        `powershell -NoProfile -NonInteractive -EncodedCommand ${encodedPowerShell(assertion)}`,
      ),
    },
    {
      type: "write-admitted-filter",
      path: config.admissionFilterXmlPath,
      content: renderAdmissionFilterXml(config, true),
    },
    {
      type: "open-runner-egress",
      ...virsh(config, "nwfilter-define", config.admissionFilterXmlPath),
    },
  ];
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? "signal"}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    } else if (step.type === "write-admission-gate") {
      await writeFile(step.path, step.content, "utf8");
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
  await executeHostAdmissionPlan(plan);
  return {
    action: "admit",
    runId: options.runId,
    domainName: options.config.domainName,
    guestInputPath: options.guestInputPath,
    runnerAdmitted: true,
  };
}

export async function executeHostAdmissionPlan(
  plan,
  { runCommand = run, writeText = writeFile } = {},
) {
  for (const step of plan) {
    if (step.type === "write-admitted-filter") {
      await writeText(step.path, step.content, "utf8");
    } else {
      await runCommand(step.command, step.args);
    }
  }
}

export function parseHostOptions(args) {
  const action = args[0];
  if (action !== "reconstruct" && action !== "admit") {
    throw new Error("action must be reconstruct or admit");
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

async function main() {
  const options = parseHostOptions(process.argv.slice(2));
  const result =
    options.action === "reconstruct"
      ? await executeReconstruction(options)
      : await executeAdmission(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
