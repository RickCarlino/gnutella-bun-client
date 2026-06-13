import { QRP_HASH_MULTIPLIER } from "./constants";

function qrpHashBytes(str: string): number[] {
  const bytes: number[] = [];
  for (const char of str) {
    let codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x41 && codePoint <= 0x5a) codePoint += 0x20;
    if (codePoint <= 0xffff) {
      bytes.push(codePoint & 0xff);
      continue;
    }
    const value = codePoint - 0x10000;
    const high = 0xd800 + (value >> 10);
    const low = 0xdc00 + (value & 0x3ff);
    bytes.push(high & 0xff, low & 0xff);
  }
  return bytes;
}

export function qrpHash(str: string, bits: number): number {
  const bytes = qrpHashBytes(str);
  let xor = 0;
  for (let i = 0; i < bytes.length; i++) xor ^= bytes[i] << ((i & 3) * 8);
  const prod = BigInt(xor >>> 0) * BigInt(QRP_HASH_MULTIPLIER >>> 0);
  const mask = (1n << BigInt(bits)) - 1n;
  return Number((prod >> BigInt(32 - bits)) & mask) >>> 0;
}
