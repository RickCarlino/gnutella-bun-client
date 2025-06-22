import { describe, test, expect } from "bun:test";
import { IDGenerator } from "./id_generator";

describe("IDGenerator", () => {
  test("generate returns buffer with flags", () => {
    const id = IDGenerator.generate();
    expect(id.length).toBe(16);
    expect(id[8]).toBe(0xff);
    expect(id[15]).toBe(0x00);
  });

  test("servent returns deterministic id", () => {
    const expected = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ];
    expect(Array.from(IDGenerator.servent())).toEqual(expected);
  });
});
