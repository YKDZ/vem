#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
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
  if (
    report?.ok !== true ||
    runtime?.schemaVersion !== "runtime-acceptance-report/v1" ||
    kiosk?.sessionUser !== "VEMKiosk" ||
    !Number.isInteger(kiosk?.sessionId) ||
    kiosk.sessionId < 1 ||
    typeof kiosk?.url !== "string"
  ) {
    throw new Error(
      "runtime acceptance report must prove an active VEMKiosk session",
    );
  }
  return {
    normalTargetId:
      typeof kiosk.cdpTargetId === "string" && kiosk.cdpTargetId
        ? kiosk.cdpTargetId
        : null,
    sessionUser: kiosk.sessionUser,
    sessionId: kiosk.sessionId,
    route: routeFromTauriUrl(kiosk.url),
    url: kiosk.url,
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
      selector: '[data-test="catalog-category"]',
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
      selector: '[data-test="payment-option"]',
      routeBefore: "#/checkout",
      routeAfter: "#/checkout",
      activatesRouteBarrier: true,
    },
    {
      type: "customer-activation",
      name: "payment submit",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: /^#\/payment/,
      screenshot: true,
    },
  ];
  if (profile !== "vm-normal") {
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

function createRunnerTrust(root) {
  const signingKeyFile = join(root, "runner-ed25519.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    signingKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    {
      mode: 0o600,
    },
  );
  return {
    signingKeyFile,
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
  return { path, owned: true };
}

function runCommand(command, label) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return result;
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

function optionalObservedIdentity(values, name, exposed) {
  if (exposed) return observedIdentity(values, name);
  const occurrences = values.filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (occurrences.length !== 0) {
    throw new Error(
      `${name} must be absent when platform evidence is unavailable`,
    );
  }
  return { occurrences: [], unique: [], count: 0 };
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

function deriveCorrelation({
  payment,
  fulfillment,
  serial,
  completion,
  saleCorrelationId,
}) {
  const platform = completion?.simulatedHardwareSaleFlow;
  const sale = platform?.sale;
  const movement = platform?.platformState?.postSaleDispenseMovement;
  const platformIdentities = platform?.platformState?.observedIdentities;
  const reservation = platform?.platformState?.reservation;
  const reservationExposed = reservation?.exposed === true;
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
    movement?.orderId === rendered.orderId &&
    movement?.vendingCommandId === rendered.commandId;
  const observations = {
    orderIds: observedIdentity(
      platformIdentities?.orderIds ?? [],
      "platform order evidence",
    ),
    paymentIds: observedIdentity(
      platformIdentities?.paymentIds ?? [],
      "platform payment evidence",
    ),
    orderNos: observedIdentity(
      platformIdentities?.orderNos ?? [],
      "platform order-number evidence",
    ),
    commandIds: observedIdentity(
      platformIdentities?.commandIds ?? [],
      "platform command evidence",
    ),
    movementIds: observedIdentity(
      platformIdentities?.movementIds ?? [],
      "platform movement evidence",
    ),
    reservationIds: optionalObservedIdentity(
      platformIdentities?.reservationIds ?? [],
      "platform reservation evidence",
      reservationExposed,
    ),
  };
  const reservationEvidenceMatches = reservationExposed
    ? typeof reservation?.source === "string" &&
      reservation.source !== "not_exposed" &&
      Number.isSafeInteger(reservation.rawRecordCount) &&
      reservation.rawRecordCount === observations.reservationIds.count &&
      observations.reservationIds.count === 1
    : reservation?.source === "not_exposed" &&
      reservation?.rawRecordCount === 0 &&
      observations.reservationIds.count === 0;
  const exactOnce = {
    orderCount: observations.orderIds.count,
    paymentCount: observations.paymentIds.count,
    orderNoCount: observations.orderNos.count,
    reservationCount: observations.reservationIds.count,
    commandCount: observations.commandIds.count,
    movementCount: observations.movementIds.count,
    stockDelta: movement?.deltaQuantity,
    serialSaleBindingCount: bindings.counts,
  };
  if (
    !identitiesMatch ||
    !reservationEvidenceMatches ||
    observations.orderIds.count !== 1 ||
    observations.paymentIds.count !== 1 ||
    observations.commandIds.count !== 1 ||
    observations.movementIds.count !== 1 ||
    movement?.status !== "accepted" ||
    movement?.deltaQuantity !== -1 ||
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
      stockMovementId: movement.movementId,
      stockDelta: movement.deltaQuantity,
      status: movement.status,
      observations,
      reservation: {
        exposed: reservationExposed,
        source: reservation?.source ?? "not_exposed",
        rawRecordCount: reservation?.rawRecordCount ?? 0,
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
    },
  };
}

export async function runInstalledKioskSaleAcceptanceCli(
  options,
  dependencies = {},
) {
  const plan = buildInstalledKioskSaleAcceptancePlan(options);
  const remote = executionOptions(options);
  const runtime = readRuntimeBinding(options.runtime_acceptance_report);
  mkdirSync(dirname(resolve(options.out)), { recursive: true, mode: 0o700 });
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
  let launch;
  let cleanup;
  let primaryError;
  try {
    run(plan.fixtureCommand, "simulated hardware fixture");
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
    });
    writeJson(plan.artifacts.scenarioReport, scenario);
    const payment = await capture({
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
        .update(JSON.stringify(scenario))
        .digest("hex"),
    };
    writeJson(plan.artifacts.bindingReport, binding, 0o600);
    const saleCorrelationId = `sale-correlation://installed-kiosk-${options.run_id.toLowerCase()}`;
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
      `vm-lifecycle://${options.run_id.toLowerCase()}.installed-kiosk-sale`,
      "--sale-correlation-id",
      saleCorrelationId,
      "--machine-code",
      options.machine_code,
      "--ephemeral-platform-evidence",
      options.ephemeral_platform_evidence,
      "--customer-ui-sale-binding-file",
      plan.artifacts.bindingReport,
      "--sale-complete-command-json",
      JSON.stringify(completionCommand),
      "--out",
      plan.artifacts.serialReport,
    ];
    run(serialCommand, "serial conformance");
    const serial = JSON.parse(
      readFileSync(plan.artifacts.serialReport, "utf8"),
    );
    const completion = JSON.parse(
      readFileSync(plan.artifacts.completionReport, "utf8"),
    );
    const fulfillment = await capture({
      options: remote,
      attestation,
      selector:
        "[data-installed-kiosk-sale-fulfillment-surface], [data-installed-kiosk-sale-result-surface]",
      route: /^#\/(dispensing|result)/,
    });
    const correlation = deriveCorrelation({
      payment,
      fulfillment,
      serial,
      completion,
      saleCorrelationId,
    });
    const report = {
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
      evidence: {
        scenarioPath: plan.artifacts.scenarioReport,
        serialConformancePath: plan.artifacts.serialReport,
        completionPath: plan.artifacts.completionReport,
      },
    };
    writeJson(options.out, report);
    return report;
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
            expectedRoute: runtime.route,
          }),
        );
        if (
          cleanup?.daemonRunning !== true ||
          cleanup?.cdpListenerCount !== 0 ||
          cleanup?.normal?.principal !== launch.prelaunch.principal ||
          cleanup?.normal?.sessionId !== launch.prelaunch.sessionId ||
          cleanup?.normal?.route !== runtime.route ||
          cleanup?.normal?.routeEvidence?.source !== "remote_cdp" ||
          cleanup?.normal?.routeEvidence?.route !== runtime.route ||
          typeof cleanup?.normal?.routeEvidence?.targetId !== "string" ||
          cleanup.normal.routeEvidence.targetId.length === 0 ||
          typeof cleanup?.normal?.routeEvidence?.targetUrl !== "string" ||
          cleanup.normal.routeEvidence.targetUrl.length === 0
        ) {
          throw new Error(
            "installed kiosk cleanup did not restore normal VEMKiosk ownership",
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
}

function usage() {
  console.error(
    `Usage: installed-kiosk-sale-acceptance.mjs --run-id ID --machine-code CODE --platform-target TARGET --ephemeral-platform-evidence PATH --runtime-acceptance-report PATH (--remote USER@HOST | --factory-guest-endpoint-json JSON --expected-testbed-user USER) --identity KEY --certificate CERT --adapter PATH --target-identity ID --approved-runtime-base factory-cas://sha256/HASH [--scanner-code-file PATH] [--profile vm-normal|vm-route-competition|factory-route-competition] --out PATH [--dry-run]`,
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
      console.error(error instanceof Error ? error.message : String(error));
      usage();
      process.exitCode = 2;
    }
  })();
}
