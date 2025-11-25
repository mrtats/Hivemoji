export const PROTOCOL_ID = "hivemoji";
export const PROTOCOL_VERSION = 1;
export const MAX_JSON_BYTES = 8 * 1024;
export const SAFE_IMAGE_BYTES = 5 * 1024;
export const NAME_REGEX = /^[a-z0-9_]{1,32}$/;

export function validateName(name) {
  if (!NAME_REGEX.test(name)) {
    throw new Error("Emoji name must match [a-z0-9_]{1,32}");
  }
  return name;
}

const encoder = new TextEncoder();
export function jsonSizeBytes(payload) {
  return encoder.encode(JSON.stringify(payload)).length;
}

function contains(bytes, pattern) {
  for (let i = 0; i <= bytes.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function parsePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((v, i) => bytes[i] === v)) return null;
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const animatedHint = contains(bytes, [0x61, 0x63, 0x54, 0x4c]); // acTL chunk
  return { mime: "image/png", width, height, animatedHint };
}

function parseGif(bytes) {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  const view = new DataView(bytes.buffer);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const animatedHint =
    contains(bytes, [0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]) ||
    contains(bytes, [0x41, 0x4e, 0x49, 0x4d, 0x45, 0x58, 0x54, 0x53, 0x31, 0x2e, 0x30]);
  return { mime: "image/gif", width, height, animatedHint, loopHint: animatedHint };
}

function parseVp8(payload) {
  if (payload.length < 10) return null;
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return null;
  const view = new DataView(payload.buffer, payload.byteOffset);
  const width = view.getUint16(6, true) & 0x3fff;
  const height = view.getUint16(8, true) & 0x3fff;
  return { width, height };
}

function parseVp8l(payload) {
  if (payload.length < 5 || payload[0] !== 0x2f) return null;
  const b1 = payload[1];
  const b2 = payload[2];
  const b3 = payload[3];
  const b4 = payload[4];
  const width = 1 + (((b2 & 0x3f) << 8) | b1);
  const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
  return { width, height };
}

function parseVp8x(payload) {
  if (payload.length < 10) return null;
  const animatedHint = (payload[0] & 0x02) === 0x02;
  const view = new DataView(payload.buffer, payload.byteOffset);
  const widthMinusOne = view.getUint32(4, true) & 0x00ffffff;
  const heightMinusOne = view.getUint32(7, true) & 0x00ffffff;
  return {
    width: widthMinusOne + 1,
    height: heightMinusOne + 1,
    animatedHint,
    loopHint: animatedHint,
  };
}

function parseWebp(bytes) {
  if (bytes.length < 12) return null;
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const webp = String.fromCharCode(...bytes.subarray(8, 12));
  if (riff !== "RIFF" || webp !== "WEBP") return null;

  let offset = 12;
  let animatedHint = false;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const chunkSize = view.getUint32(4, true);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (payloadEnd > bytes.length) break;

    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (chunkId === "VP8X") {
      const parsed = parseVp8x(payload);
      if (parsed) {
        animatedHint = animatedHint || parsed.animatedHint;
        return { mime: "image/webp", animatedHint, ...parsed };
      }
    }
    if (chunkId === "VP8 ") {
      const parsed = parseVp8(payload);
      if (parsed) return { mime: "image/webp", animatedHint, ...parsed };
    }
    if (chunkId === "VP8L") {
      const parsed = parseVp8l(payload);
      if (parsed) return { mime: "image/webp", animatedHint, ...parsed };
    }

    offset = payloadEnd + (chunkSize % 2);
  }

  return null;
}

function detectImage(bytes) {
  return parsePng(bytes) ?? parseGif(bytes) ?? parseWebp(bytes);
}

function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function readImageFile(file) {
  if (!file) throw new Error("Emoji file is required");
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.length > SAFE_IMAGE_BYTES) {
    throw new Error(
      `Raw image is ${buffer.length} bytes; keep it <= ${SAFE_IMAGE_BYTES} to stay under custom_json limits`
    );
  }

  const info = detectImage(buffer);
  if (!info) {
    throw new Error("Unsupported image format; use PNG, WebP, or GIF/APNG");
  }
  if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) {
    throw new Error("Image dimensions must be positive numbers");
  }

  const data = arrayBufferToBase64(buffer);
  return { ...info, data, bytes: buffer.length };
}
