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
const pbes2OidValue = Buffer.from("2a864886f70d01050d", "hex");

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

function readDerElement(bytes, offset) {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  let headerBytes = 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes === 0 ||
      lengthBytes > 4 ||
      offset + 2 + lengthBytes > bytes.length
    ) {
      return null;
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[offset + 2 + index];
    }
    headerBytes += lengthBytes;
  }
  const contentStart = offset + headerBytes;
  const end = contentStart + length;
  if (end > bytes.length) return null;
  return { tag, contentStart, end, next: end };
}

function isPasswordEncryptedPkcs8(bytes) {
  const outer = readDerElement(bytes, 0);
  if (!outer || outer.tag !== 0x30 || outer.end !== bytes.length) return false;
  const algorithm = readDerElement(bytes, outer.contentStart);
  if (!algorithm || algorithm.tag !== 0x30) return false;
  const oid = readDerElement(bytes, algorithm.contentStart);
  if (
    !oid ||
    oid.tag !== 0x06 ||
    !bytes.subarray(oid.contentStart, oid.end).equals(pbes2OidValue)
  ) {
    return false;
  }
  const encryptedData = readDerElement(bytes, algorithm.next);
  return (
    encryptedData?.tag === 0x04 &&
    encryptedData.next === outer.end &&
    encryptedData.end > encryptedData.contentStart
  );
}

function textRepresentations(bytes) {
  const texts = [bytes.toString("utf8")];
  if (bytes.length >= 4) texts.push(bytes.toString("utf16le"));
  return texts;
}

function scanZipEntries(bytes, label, state, depth) {
  const invalidArchive = () => {
    throw new Error(`${label} contains an invalid archive structure`);
  };
  const startsWithLocalHeader =
    bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const findRecognizableContainer = () => {
    const endSignature = Buffer.from("504b0506", "hex");
    let searchFrom = bytes.length - 4;
    while (searchFrom >= 0) {
      const endOffset = bytes.lastIndexOf(endSignature, searchFrom);
      if (endOffset < 0) return null;
      searchFrom = endOffset - 1;
      if (endOffset + 22 > bytes.length) continue;
      const archiveEnd = endOffset + 22 + bytes.readUInt16LE(endOffset + 20);
      if (archiveEnd > bytes.length) continue;
      const diskNumber = bytes.readUInt16LE(endOffset + 4);
      const centralDisk = bytes.readUInt16LE(endOffset + 6);
      const diskEntryCount = bytes.readUInt16LE(endOffset + 8);
      const entryCount = bytes.readUInt16LE(endOffset + 10);
      const centralSize = bytes.readUInt32LE(endOffset + 12);
      const centralStart = bytes.readUInt32LE(endOffset + 16);
      if (
        diskNumber !== 0 ||
        centralDisk !== 0 ||
        diskEntryCount !== entryCount ||
        centralSize === 0xffffffff ||
        centralStart === 0xffffffff ||
        centralStart + centralSize !== endOffset
      ) {
        continue;
      }
      let centralOffset = centralStart;
      let recognizable = true;
      const entriesToCheck = Math.min(entryCount, MAX_ARCHIVE_ENTRIES + 1);
      for (let index = 0; index < entriesToCheck; index += 1) {
        if (
          centralOffset + 46 > endOffset ||
          bytes.readUInt32LE(centralOffset) !== 0x02014b50
        ) {
          recognizable = false;
          break;
        }
        const nameLength = bytes.readUInt16LE(centralOffset + 28);
        const extraLength = bytes.readUInt16LE(centralOffset + 30);
        const commentLength = bytes.readUInt16LE(centralOffset + 32);
        const localOffset = bytes.readUInt32LE(centralOffset + 42);
        if (
          localOffset + 30 > centralStart ||
          bytes.readUInt32LE(localOffset) !== 0x04034b50
        ) {
          recognizable = false;
          break;
        }
        centralOffset += 46 + nameLength + extraLength + commentLength;
      }
      if (
        recognizable &&
        (entryCount > MAX_ARCHIVE_ENTRIES || centralOffset === endOffset)
      ) {
        return { archiveEnd };
      }
    }
    return null;
  };
  const recognizableContainer = findRecognizableContainer();
  if (
    recognizableContainer &&
    (!startsWithLocalHeader ||
      recognizableContainer.archiveEnd !== bytes.length)
  ) {
    invalidArchive();
  }
  if (!startsWithLocalHeader) return;
  if (bytes.length < 30) invalidArchive();
  const parseExtraFields = (extra) => {
    let offset = 0;
    while (offset < extra.length) {
      if (offset + 4 > extra.length) invalidArchive();
      const id = extra.readUInt16LE(offset);
      const size = extra.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + size > extra.length || id === 0x0001) invalidArchive();
      offset += size;
    }
  };
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
    if (content.length !== uncompressedSize) invalidArchive();
    scanBytes(content, `${label}:${name}`, state, depth + 1);
  };

  let endOffset = -1;
  const minimumEndOffset = Math.max(0, bytes.length - 65_557);
  for (
    let offset = bytes.length - 22;
    offset >= minimumEndOffset;
    offset -= 1
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) invalidArchive();

  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntryCount = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralStart = bytes.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralStart === 0xffffffff ||
    centralStart + centralSize !== endOffset
  ) {
    invalidArchive();
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`${label} exceeds the bounded archive scan budget`);
  }
  const endComment = bytes.subarray(endOffset + 22);
  if (endComment.indexOf(Buffer.from("504b0304", "hex")) >= 0) invalidArchive();

  const centralEntries = new Map();
  let centralOffset = centralStart;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      centralOffset + 46 > endOffset ||
      bytes.readUInt32LE(centralOffset) !== 0x02014b50
    ) {
      invalidArchive();
    }
    const flags = bytes.readUInt16LE(centralOffset + 8);
    const method = bytes.readUInt16LE(centralOffset + 10);
    const crc = bytes.readUInt32LE(centralOffset + 16);
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    const centralEnd =
      centralOffset + 46 + nameLength + extraLength + commentLength;
    if (
      centralEnd > endOffset ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      localOffset >= centralStart ||
      centralEntries.has(localOffset)
    ) {
      invalidArchive();
    }
    if ((flags & 0x41) !== 0) {
      throw new Error(`${label} contains an encrypted archive entry`);
    }
    if ((flags & 0x08) !== 0) {
      throw new Error(
        `${label} uses an unsupported archive form for bounded scanning`,
      );
    }
    const nameBytes = bytes.subarray(
      centralOffset + 46,
      centralOffset + 46 + nameLength,
    );
    parseExtraFields(
      bytes.subarray(
        centralOffset + 46 + nameLength,
        centralOffset + 46 + nameLength + extraLength,
      ),
    );
    centralEntries.set(localOffset, {
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      nameBytes,
    });
    centralOffset = centralEnd;
  }
  if (centralOffset !== endOffset) invalidArchive();

  let localOffset = 0;
  let expandedBytes = 0;
  let localEntryCount = 0;
  while (localOffset < centralStart) {
    if (
      localOffset + 30 > centralStart ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      invalidArchive();
    }
    const central = centralEntries.get(localOffset);
    if (!central) invalidArchive();
    const flags = bytes.readUInt16LE(localOffset + 6);
    const method = bytes.readUInt16LE(localOffset + 8);
    const crc = bytes.readUInt32LE(localOffset + 14);
    const compressedSize = bytes.readUInt32LE(localOffset + 18);
    const uncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const nameLength = bytes.readUInt16LE(localOffset + 26);
    const extraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataStart > centralStart ||
      dataEnd > centralStart ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      flags !== central.flags ||
      method !== central.method ||
      crc !== central.crc ||
      compressedSize !== central.compressedSize ||
      uncompressedSize !== central.uncompressedSize ||
      !bytes
        .subarray(localOffset + 30, localOffset + 30 + nameLength)
        .equals(central.nameBytes)
    ) {
      invalidArchive();
    }
    if ((flags & 0x41) !== 0) {
      throw new Error(`${label} contains an encrypted archive entry`);
    }
    if ((flags & 0x08) !== 0) {
      throw new Error(
        `${label} uses an unsupported archive form for bounded scanning`,
      );
    }
    parseExtraFields(bytes.subarray(localOffset + 30 + nameLength, dataStart));
    expandedBytes += uncompressedSize;
    scanEntry({
      compressedSize,
      uncompressedSize,
      method,
      name: central.nameBytes.toString("utf8"),
      dataStart,
      expandedBytes,
    });
    centralEntries.delete(localOffset);
    localEntryCount += 1;
    localOffset = dataEnd;
  }
  if (
    localOffset !== centralStart ||
    localEntryCount !== entryCount ||
    centralEntries.size !== 0
  ) {
    invalidArchive();
  }
}

function scanBytes(bytes, label, state, depth) {
  if (depth > 0) state.decodedBytes += bytes.length;
  if (state.decodedBytes > MAX_DECODED_BYTES) {
    throw new Error(`${label} exceeds the bounded private-key scan budget`);
  }
  if (
    isDerPrivateKey(bytes) ||
    isPasswordEncryptedPkcs8(bytes) ||
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
