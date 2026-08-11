#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const BINARY_ALLOWLIST_NAME = "hard-cutover-binary-allowlist.json";
const BINARY_ALLOWLIST_SCHEMA = "vem-hard-cutover-binary-allowlist/v1";
const BINARY_POLICIES = Object.freeze({
  "historical-test-fixture": Object.freeze({
    exactPath: "scripts/testbed/fixtures/try-on-" + "sil" + "houette.png",
    reason:
      "Digest-pinned hard-cutover test fixture; never executed or deployed.",
  }),
  "machine-audio": Object.freeze({
    prefixes: ["apps/machine/public/audio/", "apps/machine/src/assets/audio/"],
    suffixes: [".mp3", ".wav"],
    reason: "Production Machine audio asset.",
  }),
  "machine-ui-asset": Object.freeze({
    prefixes: ["apps/machine/src-tauri/", "apps/machine/src/assets/"],
    suffixes: [".ico", ".jpg", ".png"],
    reason: "Production Machine UI image asset.",
  }),
  "operator-manual-screenshot": Object.freeze({
    prefixes: ["public/manual/screenshots/"],
    suffixes: [".jpg", ".png"],
    reason: "Maintained operator manual screenshot.",
  }),
});
const FORBIDDEN_PATTERNS = Object.freeze([
  { category: "protocol-v1", pattern: /\bvem[.]vision[.]v1\b/ },
  { category: "legacy-v1-fixture", pattern: /\brejects-v[0-9]-protocol\b/ },
  {
    category: "legacy-try-on-wire-message",
    pattern: /\bvision[.]try_on[.](?:start|stop|started|stopped)\b/,
  },
  {
    category: "obsolete-try-on-progress-event",
    pattern: /\bvision[.]try_on[.]attempt[.]progress\b/,
  },
  {
    category: "legacy-try-on-client",
    pattern:
      /\b(?:openVisionTryOnSess[i]on|VisionTryOnSess[i]on|useTryOnPrev[i]ew)\b/,
  },
  {
    category: "legacy-preview-route",
    pattern: /\/try-on\/\{[^}]+}[.]mjpeg\b|try-on-prev[i]ew\b/i,
  },
  {
    category: "legacy-silhouette",
    pattern: /(?<!legacy-)\bsilhouette\b/i,
  },
  {
    category: "legacy-silhouette-field",
    pattern: /try[_-]?on[_-]?silhouett[e]|tryOnSilhouett[e]/i,
  },
  {
    category: "legacy-silhouette-purpose",
    pattern: /try[_-]?on[_-]?silhouett[e](?:[_-]?media)?|tryOnSilhouett[e]/i,
  },
  {
    category: "legacy-silhouette-upload-endpoint",
    pattern: /\/media-assets\/try-on-silhouett[e]s/i,
  },
  {
    category: "legacy-start-stop-operation",
    pattern: /\btry_on[.](?:start|stop)_preview\b/,
  },
  {
    category: "legacy-nested-customer-route",
    pattern:
      /#\/products\/[^\s"'`]+\/try-on\b|path\s*:\s*["']\/products\/:[^"']+\/try-on\b/,
  },
  {
    category: "legacy-try-on-selector",
    pattern: /(?:data-test\s*=\s*["']|\[data-test=["'])try-on-exit\b/,
  },
  {
    category: "fabricated-try-on-phase-evidence",
    pattern: /\b(?:accepted|progress|completed)Observed\b/,
  },
  {
    category: "legacy-try-on-session-module",
    pattern: /\b(?:VisionTryOnSess[i]on|try_on_sess[i]on|tryOnSess[i]on)\b/,
  },
  {
    category: "standalone-repository-url",
    pattern:
      /(?:https?:\/\/github[.]com\/hbhjt\/|(?:git[+]ssh|ssh):\/\/(?:git@)?github[.]com\/hbhjt\/|git@github[.]com:hbhjt\/)virtual-tryon(?:[.]git)?(?![-\w])/i,
  },
  {
    category: "standalone-repository-path",
    pattern:
      /(?:[.][.][\\/]|[A-Za-z]:[\\/]|\/workspaces\/)?virtual-tryon[\\/](?:run[.]ps1|app[\\/]|static[\\/]|scripts[\\/]|requirements[.]txt|vendor[\\/])/i,
  },
  {
    category: "standalone-server-entrypoint",
    pattern:
      /\bapp[.]main:app\b|\bfrom\s+app[.]main\s+import\s+[A-Za-z_]\w*|\bimport\s+app[.]main\b|\bimportlib(?:[.]import_module)?\s*[(]\s*["']app[.]main["']|\buvicorn(?:[.]run)?\s*[(]?\s*["']app[.]main:app["']/,
  },
  {
    category: "standalone-browser-camera-owner",
    pattern:
      /\bnavigator\s*(?:[?]?[.]\s*mediaDevices|(?:[?][.])?\s*\[\s*["']mediaDevices["']\s*\])\s*(?:[?]?[.]\s*getUserMedia|(?:[?][.])?\s*\[\s*["']getUserMedia["']\s*\])\s*[(]/,
  },
]);

function splitLegacyConstructionMatches(source) {
  const matches = source.matchAll(
    /\[[\s\S]{0,200}?\][.]join\(\s*["']{2}\s*\)/g,
  );
  return [...matches].filter((match) => {
    const fragments = [...match[0].matchAll(/["']([^"']+)["']/g)].map(
      ([, fragment]) => fragment,
    );
    const normalized = fragments
      .join("")
      .replace(/[^a-z]/gi, "")
      .toLowerCase();
    return normalized.includes(["tryon", "sil", "houette"].join(""));
  });
}

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".ps1",
  ".sql",
  ".txt",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

function extension(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}

function shouldSkip(path, { scanArtifacts = false } = {}) {
  const names = scanArtifacts
    ? /(?:^|[\\/])(?:node_modules|target|coverage|[.]turbo|[.]git)(?:[\\/]|$)/
    : /(?:^|[\\/])(?:node_modules|dist|target|coverage|[.]turbo|[.]git)(?:[\\/]|$)/;
  return names.test(path);
}

function filesUnder(path, options = {}) {
  if (shouldSkip(path, options)) return [];
  const stats = statSync(path);
  if (!stats.isDirectory())
    return TEXT_EXTENSIONS.has(extension(path)) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(resolve(path, entry.name), options),
  );
}

function isHistoricalLegacyRecord(path) {
  return /(?:^|[\\/])docs[\\/](?:archive|软著|adr)(?:[\\/]|$)/.test(path);
}

const RETIRED_MEDIA_TOKEN = ["sil", "houette"].join("");
const LEGACY_MIGRATION_ALLOWANCES = Object.freeze({
  [`packages/db/drizzle/20260701170000_variant_try_on_${RETIRED_MEDIA_TOKEN}_media_assets/migration.sql`]:
    {
      digest:
        "90ea0d9d541a594e5aee635537838faa10e71f44d62e82119d35dcd499828816",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
  [`packages/db/drizzle/20260701171000_machine_planogram_try_on_${RETIRED_MEDIA_TOKEN}/migration.sql`]:
    {
      digest:
        "8d666502d7928114fea2aa912bdc5f57793e85091a28c34ff5fc94c7c9c43e7b",
      occurrences: {
        "legacy-silhouette-field": 1,
        "legacy-silhouette-purpose": 1,
      },
    },
  "packages/db/drizzle/20260809010000_try_on_garment_variant_associations/migration.sql":
    {
      digest:
        "a37e480d30ce79d55edb4b177d78140990e9aec77f3e68f4718b0c6930985186",
      occurrences: {
        "legacy-silhouette-field": 2,
        "legacy-silhouette-purpose": 2,
      },
    },
  "packages/db/drizzle/20260810000000_hard_delete_legacy_try_on_data/migration.sql":
    {
      digest:
        "96160d733362493722b0aa81adffb2d0ca37e7279970aa8bf1dffe2a4b51fc2f",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
  "packages/db/drizzle/20260722000000_remove_inventory_refill_authority/snapshot.json":
    {
      digest:
        "a0347f6c12811f34e14632ec3f51452cb86af315d43a220b1eb9fe42ee48b49c",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
});

const SQLITE_HISTORICAL_MIGRATION_DIGESTS = Object.freeze({
  MIGRATION_V10:
    "d6b4d396b172d96cd8222966f751190d5e0a2104c307bf4b4c64578fcec174e5",
  MIGRATION_V19:
    "d9661dc18064b8da335115f142ebde3e879858a0b3a37e3064194441bea98333",
});

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function rustMigrationLiteral(source, name) {
  return source.match(
    new RegExp(`pub const ${name}: &str = r#"([\\s\\S]*?)"#;`),
  )?.[1];
}

function legacyAllowance(path, root, source) {
  const relativePath = relative(root, path);
  const migration = LEGACY_MIGRATION_ALLOWANCES[relativePath];
  if (migration) {
    return {
      valid: digest(source) === migration.digest,
      occurrences: migration.occurrences,
      integrityLabel: "legacy-migration-digest",
    };
  }
  if (relativePath === "apps/vending-daemon/src/state/schema.rs") {
    const v10 = rustMigrationLiteral(source, "MIGRATION_V10");
    const v19 = rustMigrationLiteral(source, "MIGRATION_V19");
    const literalColumn =
      /pub const RETIRED_PLANOGRAM_MEDIA_COLUMN: &str = "try_on_silhouett[e]_url";/.test(
        source,
      );
    return {
      valid:
        v10 !== undefined &&
        v19 !== undefined &&
        digest(v10) === SQLITE_HISTORICAL_MIGRATION_DIGESTS.MIGRATION_V10 &&
        digest(v19) === SQLITE_HISTORICAL_MIGRATION_DIGESTS.MIGRATION_V19 &&
        literalColumn,
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
      integrityLabel: "sqlite-history-or-tombstone",
    };
  }
  return null;
}

function patternMatches(source, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function binaryEntryMatchesPolicy(entry) {
  const policy = BINARY_POLICIES[entry.category];
  if (!policy || entry.reason !== policy.reason) return false;
  if (policy.exactPath) return entry.path === policy.exactPath;
  return (
    policy.prefixes.some((prefix) => entry.path.startsWith(prefix)) &&
    policy.suffixes.some((suffix) => entry.path.endsWith(suffix))
  );
}

function loadBinaryAllowlist(root, trackedEntries, violations) {
  const trackedManifest = trackedEntries.find(
    ({ relativePath }) => relativePath === BINARY_ALLOWLIST_NAME,
  );
  if (!trackedManifest || trackedManifest.mode !== "100644") {
    violations.push(`${BINARY_ALLOWLIST_NAME}:binary-allowlist-untracked`);
    return { approved: new Map(), source: null };
  }
  let source;
  let manifest;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(resolve(root, BINARY_ALLOWLIST_NAME)),
    );
    manifest = JSON.parse(source);
  } catch {
    violations.push(`${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`);
    return { approved: new Map(), source: null };
  }
  const canonical = `${JSON.stringify(canonicalJson(manifest), null, 2)}\n`;
  if (
    source !== canonical ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "entries,schemaVersion" ||
    manifest.schemaVersion !== BINARY_ALLOWLIST_SCHEMA ||
    !Array.isArray(manifest.entries)
  ) {
    violations.push(`${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`);
    return { approved: new Map(), source: null };
  }
  const approved = new Map();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !==
        "category,gitMode,path,reason,sha256" ||
      Object.values(entry).some((value) => typeof value !== "string") ||
      approved.has(entry.path) ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..") ||
      entry.gitMode !== "100644" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !binaryEntryMatchesPolicy(entry)
    ) {
      violations.push(`${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`);
      return { approved: new Map(), source: null };
    }
    approved.set(entry.path, entry);
  }
  if (
    [...approved.keys()].join("\0") !== [...approved.keys()].sort().join("\0")
  ) {
    violations.push(`${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`);
    return { approved: new Map(), source: null };
  }
  return { approved, source };
}

const EXECUTABLE_MAGICS = [
  Buffer.from("MZ"),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
];

function startsWith(bytes, prefix) {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes) {
  if (!startsWith(bytes, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return false;
  }
  let offset = 8;
  let sawHeader = false;
  let sawImageData = false;
  let imageDataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) return false;
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkData = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      bytes.readUInt32BE(offset + 8 + length) !==
      crc32(bytes.subarray(offset + 4, offset + 8), chunkData)
    ) {
      return false;
    }
    if (!sawHeader) {
      if (chunkType !== "IHDR" || length !== 13) return false;
      if (
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0
      ) {
        return false;
      }
      sawHeader = true;
    } else if (chunkType === "IHDR") {
      return false;
    }
    if (chunkType === "IDAT") {
      if (length === 0 || imageDataEnded) return false;
      sawImageData = true;
    } else if (sawImageData && chunkType !== "IEND") {
      imageDataEnded = true;
    }
    if (chunkType === "IEND") {
      return (
        length === 0 && sawHeader && sawImageData && chunkEnd === bytes.length
      );
    }
    offset = chunkEnd;
  }
  return false;
}

function validJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false;
  }
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawScanData = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) {
      return sawFrame && sawScan && sawScanData && offset === bytes.length;
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8) return false;
    if (marker >= 0xd0 && marker <= 0xd7) return false;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return false;
    }
    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (sawFrame || segmentLength < 8) return false;
      const componentCount = bytes[segmentStart + 5];
      if (
        bytes.readUInt16BE(segmentStart + 1) === 0 ||
        bytes.readUInt16BE(segmentStart + 3) === 0 ||
        componentCount === 0 ||
        segmentLength !== 8 + 3 * componentCount
      ) {
        return false;
      }
      sawFrame = true;
    }
    if (marker === 0xda) {
      const componentCount = bytes[segmentStart];
      if (
        !sawFrame ||
        sawScan ||
        componentCount === 0 ||
        segmentLength !== 6 + 2 * componentCount
      ) {
        return false;
      }
      sawScan = true;
      offset = segmentEnd;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          sawScanData = true;
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
          markerOffset += 1;
        }
        if (markerOffset >= bytes.length) return false;
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00) {
          sawScanData = true;
          offset = markerOffset + 1;
          continue;
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset = markerOffset + 1;
          continue;
        }
        if (scanMarker === 0xd9) {
          return sawScanData && markerOffset + 1 === bytes.length;
        }
        return false;
      }
      return false;
    }
    offset = segmentEnd;
  }
  return false;
}

function validDib(bytes, directoryWidth, directoryHeight) {
  if (bytes.length < 40) return false;
  const headerSize = bytes.readUInt32LE(0);
  if (
    ![40, 52, 56, 108, 124].includes(headerSize) ||
    bytes.length < headerSize
  ) {
    return false;
  }
  const width = bytes.readInt32LE(4);
  const combinedHeight = bytes.readInt32LE(8);
  const planes = bytes.readUInt16LE(12);
  const bitCount = bytes.readUInt16LE(14);
  const compression = bytes.readUInt32LE(16);
  const colorsUsed = bytes.readUInt32LE(32);
  if (
    width !== directoryWidth ||
    combinedHeight <= 0 ||
    combinedHeight % 2 !== 0 ||
    combinedHeight / 2 !== directoryHeight ||
    planes !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(bitCount) ||
    ![0, 3, 6].includes(compression) ||
    (bitCount <= 8 && colorsUsed > 2 ** bitCount)
  ) {
    return false;
  }
  const height = combinedHeight / 2;
  const maskBytes =
    headerSize === 40 && compression === 3
      ? 12
      : headerSize === 40 && compression === 6
        ? 16
        : 0;
  const paletteEntries = colorsUsed || (bitCount <= 8 ? 2 ** bitCount : 0);
  const xorStride = ((BigInt(width) * BigInt(bitCount) + 31n) / 32n) * 4n;
  const andStride = ((BigInt(width) + 31n) / 32n) * 4n;
  const expectedSize =
    BigInt(headerSize + maskBytes + paletteEntries * 4) +
    (xorStride + andStride) * BigInt(height);
  return expectedSize === BigInt(bytes.length);
}

function validIco(bytes) {
  if (bytes.length < 6) return false;
  const count = bytes.readUInt16LE(4);
  if (
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1 ||
    count === 0
  ) {
    return false;
  }
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > bytes.length) return false;
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const directoryWidth = bytes[entry] || 256;
    const directoryHeight = bytes[entry + 1] || 256;
    const imageSize = bytes.readUInt32LE(entry + 8);
    const imageOffset = bytes.readUInt32LE(entry + 12);
    if (
      imageSize === 0 ||
      imageOffset < directoryEnd ||
      imageOffset + imageSize > bytes.length
    ) {
      return false;
    }
    const image = bytes.subarray(imageOffset, imageOffset + imageSize);
    if (!validPng(image) && !validDib(image, directoryWidth, directoryHeight)) {
      return false;
    }
    ranges.push([imageOffset, imageOffset + imageSize]);
  }
  ranges.sort(([left], [right]) => left - right);
  let cursor = directoryEnd;
  for (const [start, end] of ranges) {
    if (start !== cursor) return false;
    cursor = end;
  }
  return cursor === bytes.length;
}

function validWav(bytes) {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return false;
  }
  let offset = 12;
  let sawFormat = false;
  let sawData = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + length;
    const paddedEnd = chunkEnd + (length & 1);
    if (paddedEnd > bytes.length) return false;
    if (type === "fmt ") {
      if (sawFormat || length < 16) return false;
      sawFormat = true;
    } else if (type === "data") {
      if (!sawFormat || sawData || length === 0) return false;
      sawData = true;
    }
    offset = paddedEnd;
  }
  return offset === bytes.length && sawFormat && sawData;
}

function validMp3(bytes) {
  let offset = 0;
  if (bytes.toString("ascii", 0, 3) === "ID3") {
    if (
      bytes.length < 10 ||
      bytes[3] < 2 ||
      bytes[3] > 4 ||
      [...bytes.subarray(6, 10)].some((byte) => byte & 0x80)
    ) {
      return false;
    }
    const tagSize =
      (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    const hasFooter = bytes[3] === 4 && (bytes[5] & 0x10) !== 0;
    offset = 10 + tagSize + (hasFooter ? 10 : 0);
  }
  if (
    offset + 4 > bytes.length ||
    bytes[offset] !== 0xff ||
    (bytes[offset + 1] & 0xe0) !== 0xe0
  ) {
    return false;
  }
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (
    version === 1 ||
    layer === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return false;
  }
  const mpeg1Bitrates = {
    1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  };
  const mpeg2Bitrates = {
    1: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  };
  const bitrateKbps = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[layer][
    bitrateIndex - 1
  ];
  const sampleRates = [44100, 48000, 32000];
  const sampleRate =
    sampleRates[sampleRateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const padding = (bytes[offset + 2] >> 1) & 1;
  const bitrate = bitrateKbps * 1000;
  const frameLength =
    layer === 3
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor(
          ((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / sampleRate +
            padding,
        );
  return frameLength >= 4 && offset + frameLength <= bytes.length;
}

function validOgg(bytes) {
  if (
    bytes.length < 27 ||
    bytes.toString("ascii", 0, 4) !== "OggS" ||
    bytes[4] !== 0
  ) {
    return false;
  }
  const segmentCount = bytes[26];
  if (bytes.length < 27 + segmentCount) return false;
  const payloadSize = [...bytes.subarray(27, 27 + segmentCount)].reduce(
    (total, size) => total + size,
    0,
  );
  return 27 + segmentCount + payloadSize <= bytes.length;
}

function validMp4(bytes) {
  let offset = 0;
  let boxCount = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) return false;
    if (boxCount === 0) {
      if (type !== "ftyp" || size < headerSize + 8) return false;
      if ((size - headerSize - 8) % 4 !== 0) return false;
    }
    boxCount += 1;
    offset += size;
  }
  return boxCount > 0 && offset === bytes.length;
}

function validWebp(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    return false;
  }
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + length;
    if (chunkEnd > bytes.length) return false;
    sawImage ||= ["VP8 ", "VP8L", "VP8X"].includes(type);
    offset = chunkEnd + (length & 1);
  }
  return sawImage && offset === bytes.length;
}

function binaryFormatIsValid(path, bytes) {
  if (
    startsWith(bytes, Buffer.from("#!")) ||
    EXECUTABLE_MAGICS.some((magic) => startsWith(bytes, magic))
  ) {
    return false;
  }
  const validators = new Map([
    [".ico", validIco],
    [".jpeg", validJpeg],
    [".jpg", validJpeg],
    [".mp3", validMp3],
    [".mp4", validMp4],
    [".ogg", validOgg],
    [".png", validPng],
    [".wav", validWav],
    [".webp", validWebp],
  ]);
  const validator = validators.get(extname(path).toLowerCase());
  return validator !== undefined && validator(bytes);
}

export function scanHardCutoverAbsence({
  root = DEFAULT_ROOT,
  artifactScopes = [],
} = {}) {
  const trackedOutput = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
  });
  const trackedEntries = trackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const mode = record.slice(0, record.indexOf(" "));
      const relativePath = record.slice(tab + 1);
      return { mode, path: resolve(root, relativePath), relativePath };
    });
  const indexViolations = trackedEntries.flatMap(({ mode, relativePath }) => {
    if (mode === "120000") return [`${relativePath}:tracked-symlink-forbidden`];
    if (mode === "160000")
      return [`${relativePath}:tracked-submodule-forbidden`];
    if (mode !== "100644" && mode !== "100755")
      return [`${relativePath}:tracked-mode-${mode}-forbidden`];
    return [];
  });
  const trackedPaths = trackedEntries
    .filter(({ mode }) => mode === "100644" || mode === "100755")
    .map(({ path }) => path);
  const violations = [...indexViolations];
  const { approved: approvedBinary, source: binaryManifestSource } =
    loadBinaryAllowlist(root, trackedEntries, violations);
  const actualBinary = new Map();
  const paths = [
    ...trackedPaths,
    ...artifactScopes.flatMap((scope) =>
      filesUnder(resolve(root, scope), { scanArtifacts: true }),
    ),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const trackedPathSet = new Set(trackedPaths);
  violations.push(
    ...paths.flatMap((path) => {
      if (trackedPathSet.has(path)) {
        try {
          if (!lstatSync(path).isFile()) {
            return [`${relative(root, path)}:tracked-worktree-type-mismatch`];
          }
        } catch {
          return [`${relative(root, path)}:tracked-file-unreadable`];
        }
      }
      let bytes;
      try {
        bytes = readFileSync(path);
      } catch {
        return [`${relative(root, path)}:tracked-file-unreadable`];
      }
      const relativePath = relative(root, path);
      if (approvedBinary.has(relativePath)) {
        actualBinary.set(relativePath, {
          gitMode: trackedEntries.find((entry) => entry.path === path).mode,
          sha256: digest(bytes),
        });
        return binaryFormatIsValid(relativePath, bytes)
          ? []
          : [`${relativePath}:binary-format-invalid`];
      }
      if (bytes.includes(0)) {
        if (trackedPathSet.has(path)) {
          actualBinary.set(relative(root, path), {
            gitMode: trackedEntries.find((entry) => entry.path === path).mode,
            sha256: digest(bytes),
          });
          return [];
        }
        return [`${relative(root, path)}:artifact-binary-forbidden`];
      }
      let source;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        if (trackedPathSet.has(path)) {
          actualBinary.set(relative(root, path), {
            gitMode: trackedEntries.find((entry) => entry.path === path).mode,
            sha256: digest(bytes),
          });
          return [];
        }
        return [`${relative(root, path)}:artifact-binary-forbidden`];
      }
      const allowance = legacyAllowance(path, root, source);
      const integrityViolations =
        allowance !== null && !allowance.valid
          ? [`${relative(root, path)}:${allowance.integrityLabel}`]
          : [];
      return [
        ...integrityViolations,
        ...FORBIDDEN_PATTERNS.flatMap(({ category, pattern }) => {
          const matches = patternMatches(source, pattern);
          if (matches.length === 0) return [];
          if (
            relative(root, path) === BINARY_ALLOWLIST_NAME &&
            binaryManifestSource === source &&
            {
              "legacy-silhouette": 1,
              "legacy-silhouette-field": 1,
              "legacy-silhouette-purpose": 1,
            }[category] === matches.length
          ) {
            return [];
          }
          const permitted = allowance?.occurrences[category];
          if (allowance?.valid && permitted === matches.length) return [];
          if (
            isHistoricalLegacyRecord(path) &&
            [
              "protocol-v1",
              "legacy-try-on-client",
              "legacy-preview-route",
              "legacy-silhouette",
              "legacy-silhouette-field",
              "legacy-silhouette-purpose",
              "legacy-start-stop-operation",
              "legacy-try-on-session-module",
            ].includes(category)
          ) {
            return [];
          }
          return [`${relative(root, path)}:${category}`];
        }),
        ...(() => {
          const matches = splitLegacyConstructionMatches(source);
          if (matches.length === 0) return [];
          return [`${relative(root, path)}:legacy-split-construction`];
        })(),
      ];
    }),
  );
  for (const path of [...actualBinary.keys()].sort()) {
    const expected = approvedBinary.get(path);
    if (!expected) {
      violations.push(`${path}:binary-unapproved`);
      continue;
    }
    const actual = actualBinary.get(path);
    if (
      actual.gitMode !== expected.gitMode ||
      actual.sha256 !== expected.sha256
    ) {
      violations.push(`${path}:binary-identity-mismatch`);
    }
  }
  for (const path of [...approvedBinary.keys()].sort()) {
    if (!actualBinary.has(path)) {
      violations.push(`${path}:binary-allowlist-entry-missing`);
    }
  }
  return violations;
}

export function assertHardCutoverAbsence(options) {
  const violations = scanHardCutoverAbsence(options);
  if (violations.length > 0) {
    throw new Error(
      `Vision V2 hard-cutover forbidden references found:\n${violations.join("\n")}`,
    );
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const artifactScopes = [];
    for (let index = 2; index < process.argv.length; index += 1) {
      if (process.argv[index] !== "--artifact" || !process.argv[index + 1]) {
        throw new Error(
          "usage: hard-cutover-absence.mjs [--artifact <built-directory>]",
        );
      }
      artifactScopes.push(process.argv[index + 1]);
      index += 1;
    }
    assertHardCutoverAbsence({ artifactScopes });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
