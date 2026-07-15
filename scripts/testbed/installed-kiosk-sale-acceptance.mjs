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
    },
    {
      type: "customer-activation",
      name: "payment submit",
      selector: '[data-test="checkout-submit"]',
      routeBefore: "#/checkout",
      routeAfter: /^#\/payment/,
      activatesRouteBarrier: true,
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

function runCommand(command, label, { env = process.env } = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return result;
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
      platformRawRecordsReport,
      platformRawBaselineReport,
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
  const queryDatabaseUrl = process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
  if (typeof queryDatabaseUrl !== "string" || queryDatabaseUrl.trim() === "") {
    throw new Error(`${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} is required`);
  }
  const nonQueryEnvironment = nonQueryChildEnvironment();
  const queryEnvironment = {
    ...nonQueryEnvironment,
    [INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]: queryDatabaseUrl,
  };
  let launch;
  let cleanup;
  let primaryError;
  try {
    run(plan.fixtureCommand, "simulated hardware fixture", {
      env: nonQueryEnvironment,
    });
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
    run(
      platformRawQuery(plan.artifacts.platformRawBaselineReport),
      "authoritative platform raw baseline query",
      { env: queryEnvironment },
    );
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
    run(serialCommand, "serial conformance", { env: nonQueryEnvironment });
    const serial = JSON.parse(
      readFileSync(plan.artifacts.serialReport, "utf8"),
    );
    const completion = JSON.parse(
      readFileSync(plan.artifacts.completionReport, "utf8"),
    );
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
    const fulfillment = await capture({
      options: remote,
      attestation,
      selector:
        "[data-installed-kiosk-sale-fulfillment-surface], [data-installed-kiosk-sale-result-surface]",
      route: /^#\/(dispensing|result)/,
    });
    run(
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
        platformRawRecordsPath: plan.artifacts.platformRawRecordsReport,
        platformRawBaselinePath: plan.artifacts.platformRawBaselineReport,
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
      console.error(error instanceof Error ? error.message : String(error));
      usage();
      process.exitCode = 2;
    }
  })();
}
