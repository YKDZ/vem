#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const RECEIPT_SCHEMA = "vem.precutover.managed-media.v1";
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_RE = /^[A-Za-z0-9._~-]{16,128}$/;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PURPOSES = new Set(["product_display_image", "try_on_garment"]);
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has invalid keys`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "create")
    fail("usage: precutover-managed-media.mjs create ...");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("invalid CLI arguments");
    const key = flag.slice(2);
    if (!new Set(["origin", "token", "receipt"]).has(key) || key in values) {
      fail(`unknown or duplicate argument: ${flag}`);
    }
    values[key] = value;
  }
  for (const key of ["origin", "token", "receipt"]) {
    if (!values[key]) fail(`--${key} is required`);
  }
  if (!isAbsolute(values.receipt)) fail("--receipt must be an absolute path");
  if (/\s/.test(values.token) || values.token.length > 4096)
    fail("daemon token is invalid");
  const origin = new URL(values.origin);
  if (
    !new Set(["http:", "https:"]).has(origin.protocol) ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    fail("daemon origin must be an exact loopback HTTP origin");
  }
  return { ...values, origin: origin.origin };
}

async function responseBytes(response, maximum) {
  if (!response.body) fail("HTTP response has no body");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maximum) {
      await response.body.cancel().catch(() => undefined);
      fail("HTTP response exceeds its bounded size");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function request(
  url,
  { method = "GET", token, maximum = MAX_JSON_BYTES } = {},
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    fail(`HTTP ${method} failed: ${error.message}`);
  }
  if (response.status !== 200)
    fail(`HTTP ${method} returned status ${response.status}`);
  const bytes =
    method === "HEAD"
      ? Buffer.alloc(0)
      : await responseBytes(response, maximum);
  return { bytes, response };
}

async function getJson(url, token) {
  const { bytes, response } = await request(url, { token });
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType))
    fail("daemon response is not JSON");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("daemon response is invalid JSON");
  }
}

function validateDescriptor(value, label) {
  exactKeys(
    value,
    [
      "id",
      "reference",
      "digest",
      "contentType",
      "byteSize",
      "purpose",
      "revision",
    ],
    label,
  );
  if (!UUID_RE.test(value.id)) fail(`${label} id is invalid`);
  if (value.reference !== `/api/media-assets/${value.id}/content`) {
    fail(`${label} reference does not identify its id`);
  }
  if (!DIGEST_RE.test(value.digest)) fail(`${label} digest is invalid`);
  if (!CONTENT_TYPES.has(value.contentType))
    fail(`${label} content type is invalid`);
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0) {
    fail(`${label} byte size is invalid`);
  }
  if (!PURPOSES.has(value.purpose)) fail(`${label} purpose is invalid`);
  const revisionKeys =
    value.revision?.assetRevision === undefined
      ? ["catalogRevision"]
      : ["assetRevision", "catalogRevision"];
  exactKeys(value.revision, revisionKeys, `${label} revision`);
  for (const [key, revision] of Object.entries(value.revision)) {
    if (
      typeof revision !== "string" ||
      revision.length < 1 ||
      revision.length > 128
    ) {
      fail(`${label} ${key} is invalid`);
    }
  }
  return value;
}

function parseSnapshot(value, origin) {
  exactKeys(value, ["generation", "assets"], "media snapshot");
  if (
    typeof value.generation !== "string" ||
    value.generation.length < 1 ||
    value.generation.length > 128
  ) {
    fail("media generation is invalid");
  }
  if (!Array.isArray(value.assets) || value.assets.length > 256)
    fail("media assets are invalid");
  const byId = new Map();
  for (const [index, projection] of value.assets.entries()) {
    const projectionKeys =
      projection?.diagnosticReason === undefined
        ? ["descriptor", "readiness", "readyUrl", "diagnostic"]
        : [
            "descriptor",
            "readiness",
            "readyUrl",
            "diagnostic",
            "diagnosticReason",
          ];
    exactKeys(projection, projectionKeys, `media projection ${index}`);
    const descriptor = validateDescriptor(
      projection.descriptor,
      `media projection ${index}`,
    );
    if (byId.has(descriptor.id))
      fail(`duplicate managed media descriptor: ${descriptor.id}`);
    if (projection.readiness !== "ready" || projection.diagnostic !== null) {
      fail(`managed media is not ready: ${descriptor.id}`);
    }
    if (
      projection.diagnosticReason !== undefined &&
      projection.diagnosticReason !== null
    ) {
      fail(`managed media is not ready: ${descriptor.id}`);
    }
    if (typeof projection.readyUrl !== "string")
      fail(`managed media ready URL is missing: ${descriptor.id}`);
    const readyUrl = new URL(projection.readyUrl);
    if (
      readyUrl.origin !== origin ||
      readyUrl.pathname !== `/media/${descriptor.digest}`
    ) {
      fail(`managed media ready URL identity is invalid: ${descriptor.id}`);
    }
    const parameters = [...readyUrl.searchParams.entries()];
    if (
      parameters.length !== 1 ||
      parameters[0][0] !== "grant" ||
      !GRANT_RE.test(parameters[0][1])
    ) {
      fail(`managed media grant identity is invalid: ${descriptor.id}`);
    }
    byId.set(descriptor.id, { descriptor, grant: parameters[0][1], readyUrl });
  }
  return { generation: value.generation, byId };
}

function parseSaleView(value, snapshot) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("sale-view is invalid");
  if (!Array.isArray(value.items)) fail("sale-view items are invalid");
  if (
    typeof value.planogramVersion !== "string" ||
    value.planogramVersion.length < 1
  ) {
    fail("sale-view planogram version is invalid");
  }
  const observed = new Set();
  for (const [index, item] of value.items.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      fail(`sale-view item ${index} is invalid`);
    for (const [field, readyField] of [
      ["coverImageMedia", "coverImageReadyUrl"],
      ["tryOnGarmentMedia", "tryOnGarmentReadyUrl"],
    ]) {
      const descriptor = item[field];
      const readyUrl = item[readyField];
      if (descriptor === null || descriptor === undefined) {
        if (readyUrl !== null && readyUrl !== undefined)
          fail(`sale-view ${readyField} has no descriptor`);
        continue;
      }
      validateDescriptor(descriptor, `sale-view item ${index} ${field}`);
      const projection = snapshot.byId.get(descriptor.id);
      if (!projection)
        fail(
          `managed media descriptor is missing from snapshot: ${descriptor.id}`,
        );
      if (canonicalJson(descriptor) !== canonicalJson(projection.descriptor)) {
        fail(`managed media descriptor mismatch: ${descriptor.id}`);
      }
      if (readyUrl !== projection.readyUrl.href)
        fail(`managed media ready URL mismatch: ${descriptor.id}`);
      observed.add(descriptor.id);
    }
  }
  if (observed.size !== snapshot.byId.size)
    fail("media snapshot contains descriptors missing from sale-view");
  return { planogramVersion: value.planogramVersion };
}

async function proveBytes(entry) {
  const head = await request(entry.readyUrl, { method: "HEAD" });
  const expectedLength = String(entry.descriptor.byteSize);
  if (head.response.headers.get("content-length") !== expectedLength) {
    fail(`managed media byte size mismatch: ${entry.descriptor.id}`);
  }
  if (
    head.response.headers.get("content-type") !== entry.descriptor.contentType
  ) {
    fail(`managed media content type mismatch: ${entry.descriptor.id}`);
  }
  if (head.response.headers.get("etag") !== `"${entry.descriptor.digest}"`) {
    fail(`managed media digest identity mismatch: ${entry.descriptor.id}`);
  }
  const get = await request(entry.readyUrl, {
    maximum: entry.descriptor.byteSize + 1,
  });
  if (get.bytes.byteLength !== entry.descriptor.byteSize) {
    fail(`managed media byte size mismatch: ${entry.descriptor.id}`);
  }
  if (sha256(get.bytes) !== entry.descriptor.digest) {
    fail(`managed media digest mismatch: ${entry.descriptor.id}`);
  }
}

function writeAtomic(path, contents) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    fail("receipt parent is unsafe");
  const staging = join(
    parent,
    `.precutover-media-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(staging, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    linkSync(staging, path);
    rmSync(staging);
  } finally {
    rmSync(staging, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshotRaw = await getJson(
    `${options.origin}/v1/media/snapshot`,
    options.token,
  );
  const snapshot = parseSnapshot(snapshotRaw, options.origin);
  const saleRaw = await getJson(
    `${options.origin}/v1/sale-view`,
    options.token,
  );
  const sale = parseSaleView(saleRaw, snapshot);
  for (const entry of snapshot.byId.values()) await proveBytes(entry);
  const finalSnapshotRaw = await getJson(
    `${options.origin}/v1/media/snapshot`,
    options.token,
  );
  const finalSnapshot = parseSnapshot(finalSnapshotRaw, options.origin);
  const finalSaleRaw = await getJson(
    `${options.origin}/v1/sale-view`,
    options.token,
  );
  if (
    finalSnapshot.generation !== snapshot.generation ||
    canonicalJson(finalSnapshotRaw) !== canonicalJson(snapshotRaw)
  ) {
    fail("managed media generation changed during proof");
  }
  if (canonicalJson(finalSaleRaw) !== canonicalJson(saleRaw)) {
    fail("sale-view changed during managed media proof");
  }
  const assets = [...snapshot.byId.values()]
    .map(({ descriptor, grant, readyUrl }) => ({
      assetRevision: descriptor.revision.assetRevision ?? null,
      byteSize: descriptor.byteSize,
      catalogRevision: descriptor.revision.catalogRevision,
      contentType: descriptor.contentType,
      digest: descriptor.digest,
      grantSha256: sha256(grant),
      id: descriptor.id,
      loopbackPath: readyUrl.pathname,
      purpose: descriptor.purpose,
      reference: descriptor.reference,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const receipt = {
    assets,
    generation: snapshot.generation,
    observedAt: new Date().toISOString(),
    origin: options.origin,
    planogramVersion: sale.planogramVersion,
    schemaVersion: RECEIPT_SCHEMA,
  };
  writeAtomic(options.receipt, canonicalJson(receipt));
  process.stdout.write(`${options.receipt}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `precutover managed-media proof failed: ${error.message}\n`,
  );
  process.exitCode = 1;
});
