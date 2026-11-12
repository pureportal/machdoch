export interface Dimensions {
  width: number;
  height: number;
}

function png(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpeg(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const frame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (frame)
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    offset += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): Dimensions | null {
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 12) !== "WEBP")
    return null;
  const chunk = text(12, 16);
  if (chunk === "VP8X")
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  if (chunk === "VP8L") {
    const bits =
      bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ")
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  return null;
}

function gif(bytes: Uint8Array): Dimensions | null {
  if (
    bytes.length < 10 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "GIF8"
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
}
