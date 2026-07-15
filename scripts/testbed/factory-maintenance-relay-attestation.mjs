#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SCHEMA_VERSION = "factory-maintenance-relay-attestation/v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WG_KEY = /^[A-Za-z0-9+/]{43}=$/;
const INTERFACE = /^[A-Za-z0-9_.-]+$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  ) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function iso(value, label) {
  const parsed = Date.parse(string(value, label));
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function uuid(value, label) {
  if (!UUID.test(string(value, label)))
    throw new Error(`${label} must be a UUID`);
  return value;
}

function key(value, label) {
  if (!WG_KEY.test(string(value, label)))
    throw new Error(`${label} must be a WireGuard public key`);
  return value;
}

function ipv4(value, label) {
  const candidate = string(value, label);
  const parts = candidate.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    throw new Error(`${label} must be an IPv4 address`);
  }
  return candidate;
}

function endpoint(value, label) {
  const candidate = string(value, label);
  if (candidate === "(none)" || !/^.+:\d{1,5}$/.test(candidate)) {
    throw new Error(`${label} must be a WireGuard endpoint`);
  }
  return candidate;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function parseDump(output, relayPublicKey) {
  const row = output
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([publicKey]) => publicKey === relayPublicKey);
  if (!row || row.length !== 8)
    throw new Error(
      "wg show dump did not contain the session relay public key",
    );
  return {
    publicKey: row[0],
    endpoint: row[2],
    allowedIps: row[3].split(",").filter(Boolean),
    latestHandshakeEpochSeconds: Number(row[4]),
  };
}

function parseSingleValue(output, relayPublicKey, label) {
  const row = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([publicKey]) => publicKey === relayPublicKey);
  if (!row || row.length < 2)
    throw new Error(`${label} did not contain the session relay public key`);
  return row.slice(1).join(" ");
}

function parseRoute(output, destination) {
  const tokens = output.trim().split(/\s+/);
  const deviceIndex = tokens.indexOf("dev");
  const sourceIndex = tokens.indexOf("src");
  if (tokens[0] !== destination || deviceIndex < 0 || sourceIndex < 0) {
    throw new Error("ip route get did not return a route for the relay /32");
  }
  return {
    destination: `${destination}/32`,
    device: tokens[deviceIndex + 1],
    source: tokens[sourceIndex + 1],
  };
}

export function validateFactoryMaintenanceRelayAttestation(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "source",
      "startedAt",
      "completedAt",
      "session",
      "runner",
    ],
    "Factory maintenance relay attestation",
  );
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "factory-maintenance-relay-attestation"
  ) {
    throw new Error("Factory maintenance relay attestation schema is invalid");
  }
  if (value.source !== "runner-wireguard") {
    throw new Error(
      "Factory maintenance relay attestation must be runner-owned, never adapter evidence",
    );
  }
  const startedAt = iso(value.startedAt, "startedAt");
  const completedAt = iso(value.completedAt, "completedAt");
  if (completedAt < startedAt || completedAt - startedAt > 10 * 60_000) {
    throw new Error(
      "Factory maintenance relay attestation time window is invalid",
    );
  }
  const session = object(value.session, "session");
  exactKeys(
    session,
    [
      "id",
      "kind",
      "status",
      "issuedAt",
      "expiresAt",
      "sourcePeer",
      "targetMachine",
      "relay",
      "relayConvergence",
    ],
    "session",
  );
  uuid(session.id, "session.id");
  if (
    session.kind !== "ci" ||
    session.status !== "active" ||
    session.relayConvergence?.state !== "applied"
  ) {
    throw new Error(
      "control-plane session must be active CI session with applied relay convergence",
    );
  }
  const issuedAt = iso(session.issuedAt, "session.issuedAt");
  const expiresAt = iso(session.expiresAt, "session.expiresAt");
  if (expiresAt <= Date.now()) {
    throw new Error("control-plane session is expired");
  }
  if (issuedAt > startedAt || expiresAt <= completedAt) {
    throw new Error(
      "control-plane session is not current for this runner proof",
    );
  }
  exactKeys(
    session.sourcePeer,
    ["id", "role", "publicKey", "tunnelAddress"],
    "session.sourcePeer",
  );
  uuid(session.sourcePeer.id, "session.sourcePeer.id");
  if (session.sourcePeer.role !== "runner")
    throw new Error("control-plane session source must be a runner");
  key(session.sourcePeer.publicKey, "session.sourcePeer.publicKey");
  const sourceAddress = ipv4(
    session.sourcePeer.tunnelAddress,
    "session.sourcePeer.tunnelAddress",
  );
  exactKeys(
    session.targetMachine,
    ["id", "maintenancePeerId", "tunnelAddress"],
    "session.targetMachine",
  );
  uuid(session.targetMachine.id, "session.targetMachine.id");
  uuid(
    session.targetMachine.maintenancePeerId,
    "session.targetMachine.maintenancePeerId",
  );
  const targetAddress = ipv4(
    session.targetMachine.tunnelAddress,
    "session.targetMachine.tunnelAddress",
  );
  exactKeys(
    session.relay,
    [
      "id",
      "role",
      "publicKey",
      "tunnelAddress",
      ...(Object.hasOwn(session.relay, "endpoint") ? ["endpoint"] : []),
    ],
    "session.relay",
  );
  uuid(session.relay.id, "session.relay.id");
  if (session.relay.role !== "relay")
    throw new Error("control-plane session relay must have relay role");
  const relayPublicKey = key(
    session.relay.publicKey,
    "session.relay.publicKey",
  );
  ipv4(session.relay.tunnelAddress, "session.relay.tunnelAddress");
  const expectedRelayEndpoint = Object.hasOwn(session.relay, "endpoint")
    ? endpoint(session.relay.endpoint, "session.relay.endpoint")
    : null;
  const runner = object(value.runner, "runner");
  exactKeys(runner, ["interface", "relayPeer", "route"], "runner");
  if (!INTERFACE.test(string(runner.interface, "runner.interface")))
    throw new Error("runner.interface is invalid");
  exactKeys(
    runner.relayPeer,
    ["publicKey", "endpoint", "allowedIps", "latestHandshakeEpochSeconds"],
    "runner.relayPeer",
  );
  const observedRelayEndpoint = endpoint(
    runner.relayPeer.endpoint,
    "runner.relayPeer.endpoint",
  );
  if (
    key(runner.relayPeer.publicKey, "runner.relayPeer.publicKey") !==
      relayPublicKey ||
    (expectedRelayEndpoint !== null &&
      observedRelayEndpoint !== expectedRelayEndpoint)
  ) {
    throw new Error(
      "runner relay peer does not exactly bind the control-plane relay mapping",
    );
  }
  const endpointCidr = `${targetAddress}/32`;
  if (
    !Array.isArray(runner.relayPeer.allowedIps) ||
    !runner.relayPeer.allowedIps.includes(endpointCidr) ||
    runner.relayPeer.allowedIps.some((allowedIp) => !/\/32$/.test(allowedIp))
  ) {
    throw new Error(
      "runner relay peer must include the session endpoint /32 without broad AllowedIPs",
    );
  }
  const handshake = runner.relayPeer.latestHandshakeEpochSeconds;
  if (
    !Number.isInteger(handshake) ||
    handshake < Math.floor(startedAt / 1000) ||
    handshake > Math.ceil(completedAt / 1000)
  ) {
    throw new Error("runner relay peer handshake is not fresh for this proof");
  }
  exactKeys(runner.route, ["destination", "device", "source"], "runner.route");
  if (
    runner.route.destination !== endpointCidr ||
    runner.route.device !== runner.interface ||
    runner.route.source !== sourceAddress
  ) {
    throw new Error(
      "runner route does not bind the session endpoint /32, interface, and source address",
    );
  }
  return value;
}

export function collectFactoryMaintenanceRelayAttestation(session) {
  const startedAt = new Date().toISOString();
  const relay = session?.relay;
  if (!relay)
    throw new Error("control-plane maintenance session omitted relay mapping");
  const interfaceName = process.env.VEM_MAINTENANCE_RELAY_INTERFACE;
  if (!INTERFACE.test(String(interfaceName ?? "")))
    throw new Error("VEM_MAINTENANCE_RELAY_INTERFACE is required");
  run("ping", ["-c", "1", "-W", "5", relay.tunnelAddress]);
  const dump = parseDump(
    run("sudo", ["wg", "show", interfaceName, "dump"]),
    relay.publicKey,
  );
  const handshakeOutput = parseSingleValue(
    run("sudo", ["wg", "show", interfaceName, "latest-handshakes"]),
    relay.publicKey,
    "wg show latest-handshakes",
  );
  const allowedIpsOutput = parseSingleValue(
    run("sudo", ["wg", "show", interfaceName, "allowed-ips"]),
    relay.publicKey,
    "wg show allowed-ips",
  );
  if (
    Number(handshakeOutput) !== dump.latestHandshakeEpochSeconds ||
    allowedIpsOutput.split(",").filter(Boolean).join(",") !==
      dump.allowedIps.join(",")
  ) {
    throw new Error("independent WireGuard observations disagree");
  }
  const route = parseRoute(
    run("ip", ["route", "get", session.targetMachine.tunnelAddress]),
    session.targetMachine.tunnelAddress,
  );
  return validateFactoryMaintenanceRelayAttestation({
    schemaVersion: SCHEMA_VERSION,
    kind: "factory-maintenance-relay-attestation",
    source: "runner-wireguard",
    startedAt,
    completedAt: new Date().toISOString(),
    session,
    runner: { interface: interfaceName, relayPeer: dump, route },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = JSON.parse(readFileSync(readOption("--session"), "utf8"));
  writeFileSync(
    readOption("--out"),
    `${JSON.stringify(collectFactoryMaintenanceRelayAttestation(session), null, 2)}\n`,
    { mode: 0o600 },
  );
}
