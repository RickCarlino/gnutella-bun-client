import { describe, test, expect } from "bun:test";
import { IDGenerator } from "./id_generator";

describe("IDGenerator", () => {
  test("generate returns buffer with flags", () => {
    const id = IDGenerator.generate();
    expect(id.length).toBe(16);
    expect(id[8]).toBe(0xff);
    expect(id[15]).toBe(0x00);
  });

  test("servent returns random id with flags", () => {
    const id1 = IDGenerator.servent();
    const id2 = IDGenerator.servent();
    expect(id1.length).toBe(16);
    expect(id1[8]).toBe(0xff);
    expect(id1[15]).toBe(0x00);
    expect(id2.length).toBe(16);
    expect(id2[8]).toBe(0xff);
    expect(id2[15]).toBe(0x00);
    // extremely unlikely to be equal if properly random
    expect(id1.equals(id2)).toBe(false);
  });
});
