const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

export function isStructurallyValidPng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;
  let imageDataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      return false;
    }
    const chunkTypeBytes = bytes.subarray(offset + 4, offset + 8);
    const chunkType = chunkTypeBytes.toString("ascii");
    const chunkData = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      bytes.readUInt32BE(offset + 8 + length) !==
      crc32(chunkTypeBytes, chunkData)
    ) {
      return false;
    }
    if (!sawHeader) {
      if (chunkType !== "IHDR" || length !== 13) return false;
      if (chunkData.readUInt32BE(0) === 0 || chunkData.readUInt32BE(4) === 0) {
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
