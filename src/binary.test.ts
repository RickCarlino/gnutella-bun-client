import { describe, test, expect } from "bun:test";
import { Binary } from "./binary";

describe("Binary", () => {
  test("read/write UInt32LE", () => {
    const buf = Buffer.alloc(4);
    Binary.writeUInt32LE(buf, 0x12345678, 0);
    expect(Binary.readUInt32LE(buf, 0)).toBe(0x12345678);
  });

  test("ip conversions", () => {
    const ip = "192.168.1.2";
    const buf = Binary.ipToBuffer(ip);
    expect(buf).toEqual(Buffer.from([192, 168, 1, 2]));
    expect(Binary.bufferToIp(buf, 0)).toBe(ip);
  });
});
