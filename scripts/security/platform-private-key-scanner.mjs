import { createPrivateKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_BASE64_CANDIDATE_BYTES = 1024 * 1024;
const MAX_RECURSION_DEPTH = 3;
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const privateKeyPemPattern =
  /-----BEGIN\s+(?:(?:RSA|EC)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/i;
const base64Pattern =
  /(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
const pkcs12PrivateBagOids = [
  Buffer.from("060b2a864886f70d010c0a0101", "hex"),
  Buffer.from("060b2a864886f70d010c0a0102", "hex"),
];

function containsBytes(haystack, needle) {
  return haystack.indexOf(needle) >= 0;
}

function isDerPrivateKey(bytes) {
  if (bytes.length < 32 || bytes.length > MAX_BASE64_CANDIDATE_BYTES) {
    return false;
  }
  for (const type of ["pkcs8", "pkcs1", "sec1"]) {
    try {
      createPrivateKey({ key: bytes, format: "der", type });
      return true;
    } catch {
      // Try the next standard private-key encoding.
    }
  }
  return false;
}

function textRepresentations(bytes) {
  const texts = [bytes.toString("utf8")];
  if (bytes.length >= 4) texts.push(bytes.toString("utf16le"));
  return texts;
}

function scanZipEntries(bytes, label, state, depth) {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50) return;
  const scanEntry = ({
    compressedSize,
    uncompressedSize,
    method,
    name,
    dataStart,
    expandedBytes,
  }) => {
    if (
      uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES ||
      expandedBytes > MAX_DECODED_BYTES ||
      (compressedSize > 0 && uncompressedSize / compressedSize > 200)
    ) {
      throw new Error(`${label} exceeds the bounded archive scan budget`);
    }
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error(`${label} contains a truncated archive entry`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) {
      content = inflateRawSync(compressed, {
        maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES + 1,
      });
    } else {
      throw new Error(
        `${label} uses an unsupported archive compression method`,
      );
    }
    if (content.length > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`${label} exceeds the bounded archive scan budget`);
    }
    scanBytes(content, `${label}:${name}`, state, depth + 1);
  };

  const endSignature = Buffer.from("504b0506", "hex");
  const endOffset = bytes.lastIndexOf(endSignature);
  if (endOffset >= 0 && endOffset + 22 <= bytes.length) {
    const entryCount = bytes.readUInt16LE(endOffset + 10);
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`${label} exceeds the bounded archive scan budget`);
    }
    let centralOffset = bytes.readUInt32LE(endOffset + 16);
    let expandedBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (
        centralOffset + 46 > bytes.length ||
        bytes.readUInt32LE(centralOffset) !== 0x02014b50
      ) {
        throw new Error(`${label} contains an invalid archive directory`);
      }
      const method = bytes.readUInt16LE(centralOffset + 10);
      const compressedSize = bytes.readUInt32LE(centralOffset + 20);
      const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
      const nameLength = bytes.readUInt16LE(centralOffset + 28);
      const extraLength = bytes.readUInt16LE(centralOffset + 30);
      const commentLength = bytes.readUInt16LE(centralOffset + 32);
      const localOffset = bytes.readUInt32LE(centralOffset + 42);
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new Error(`${label} exceeds the bounded archive scan budget`);
      }
      if (
        localOffset + 30 > bytes.length ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50
      ) {
        throw new Error(`${label} contains an invalid archive entry`);
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const name = bytes
        .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
        .toString("utf8");
      expandedBytes += uncompressedSize;
      scanEntry({
        compressedSize,
        uncompressedSize,
        method,
        name,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
        expandedBytes,
      });
      centralOffset += 46 + nameLength + extraLength + commentLength;
    }
    return;
  }

  let offset = 0;
  let entries = 0;
  let expandedBytes = 0;
  while (
    offset + 30 <= bytes.length &&
    bytes.readUInt32LE(offset) === 0x04034b50
  ) {
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`${label} exceeds the bounded archive scan budget`);
    }
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) {
      throw new Error(
        `${label} uses an unsupported archive form for bounded scanning`,
      );
    }
    expandedBytes += uncompressedSize;
    const dataStart = offset + 30 + nameLength + extraLength;
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    scanEntry({
      compressedSize,
      uncompressedSize,
      method,
      name,
      dataStart,
      expandedBytes,
    });
    offset = dataStart + compressedSize;
  }
}

function scanBytes(bytes, label, state, depth) {
  if (depth > 0) state.decodedBytes += bytes.length;
  if (state.decodedBytes > MAX_DECODED_BYTES) {
    throw new Error(`${label} exceeds the bounded private-key scan budget`);
  }
  if (
    isDerPrivateKey(bytes) ||
    pkcs12PrivateBagOids.some((oid) => containsBytes(bytes, oid))
  ) {
    throw new Error(`${label} contains platform private-key material`);
  }
  if (depth < MAX_RECURSION_DEPTH) {
    scanZipEntries(bytes, label, state, depth);
  }

  for (const text of textRepresentations(bytes)) {
    if (privateKeyPemPattern.test(text)) {
      throw new Error(`${label} contains platform private-key material`);
    }
    if (depth >= MAX_RECURSION_DEPTH) continue;
    for (const match of text.matchAll(base64Pattern)) {
      const encoded = match[0];
      if (encoded.length > MAX_BASE64_CANDIDATE_BYTES * 2) continue;
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length < 24 || decoded.length > MAX_BASE64_CANDIDATE_BYTES) {
        continue;
      }
      scanBytes(decoded, `${label} (base64)`, state, depth + 1);
    }
  }
}

export function assertNoPlatformPrivateKeyMaterial(input, label) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new Error(
      `${label} exceeds the bounded private-key scan input limit`,
    );
  }
  scanBytes(bytes, label, { decodedBytes: 0 }, 0);
}

export async function assertNoPlatformPrivateKeyMaterialFile(path, label) {
  const file = await stat(path);
  if (file.size <= MAX_INPUT_BYTES) {
    const chunks = [];
    for await (const chunk of createReadStream(path)) chunks.push(chunk);
    assertNoPlatformPrivateKeyMaterial(Buffer.concat(chunks), label);
    return;
  }

  let overlap = Buffer.alloc(0);
  let offset = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1024 * 1024,
  })) {
    const window = Buffer.concat([overlap, chunk]);
    scanBytes(window, `${label}@${offset}`, { decodedBytes: 0 }, 0);
    overlap = window.subarray(Math.max(0, window.length - 4096));
    offset += chunk.length;
  }
}
