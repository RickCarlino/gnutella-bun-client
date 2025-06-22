import { describe, test, expect } from "bun:test";
import { Hash } from "./hash";
import crypto from "crypto";

function qrpExpected(str: string, bits: number): number {
  const A_INT = 1327217884;
  const bytes = new TextEncoder().encode(str.toLowerCase());
  let xor = 0;
  for (let i = 0; i < bytes.length; i++) {
    xor ^= bytes[i] << ((i & 3) * 8);
  }
  const prod = BigInt(xor >>> 0) * BigInt(A_INT);
  const mask = (1n << BigInt(bits)) - 1n;
  return Number((prod >> BigInt(32 - bits)) & mask) >>> 0;
}

function base32(buf: Buffer): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let value = 0;
  let bits = 0;

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += chars[(value << (5 - bits)) & 31];
  }
  return result.padEnd(32, "=");
}

describe("Hash", () => {
  test("qrp hashing matches algorithm", () => {
    const str = "Hello world";
    expect(Hash.qrp(str, 8)).toBe(qrpExpected(str, 8));
  });

  test("sha1 returns correct buffer", () => {
    const expected = crypto.createHash("sha1").update("hello").digest();
    expect(Hash.sha1("hello")).toEqual(expected);
  });

  test("sha1ToBase32 converts correctly", () => {
    const sha = crypto.createHash("sha1").update("hello").digest();
    expect(Hash.sha1ToBase32(sha)).toBe(base32(sha));
  });

  test("sha1ToUrn adds prefix", () => {
    const sha = crypto.createHash("sha1").update("hello").digest();
    expect(Hash.sha1ToUrn(sha)).toBe(`urn:sha1:${base32(sha)}`);
  });
});
