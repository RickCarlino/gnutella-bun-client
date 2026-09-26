import { expect, test } from "bun:test";
import zlib from "node:zlib";
import { MAX_PAYLOAD_BYTES } from "../../../src/const";
import { encodeGgep, parseGgep } from "../../../src/wire/ggep";

function compressedItem(data: Buffer, last = true): Buffer {
  const compressed = zlib.deflateRawSync(data);
  const length = compressed.length;
  expect(length).toBeLessThan(1 << 18);
  return Buffer.concat([
    Buffer.from([
      (last ? 0x80 : 0) | 0x20 | 1,
      0x58, // X
      0x80 | ((length >> 12) & 0x3f),
      0x80 | ((length >> 6) & 0x3f),
      0x40 | (length & 0x3f),
    ]),
    compressed,
  ]);
}

function block(...items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xc3]), ...items]);
}

test("decodes compressed GGEP up to the output budget", () => {
  const data = Buffer.alloc(MAX_PAYLOAD_BYTES, 65);
  expect(parseGgep(block(compressedItem(data)))).toEqual([
    { id: "X", data },
  ]);
});

test("rejects a small GGEP field expanding to 32 MiB", () => {
  const raw = block(compressedItem(Buffer.alloc(32 * 1024 * 1024, 65)));
  expect(raw.length).toBeLessThan(40 * 1024);
  expect(() => parseGgep(raw)).toThrow();
});

test("rejects GGEP output one byte over budget", () => {
  expect(() =>
    parseGgep(block(compressedItem(Buffer.alloc(MAX_PAYLOAD_BYTES + 1)))),
  ).toThrow();
});

test("shares the GGEP budget across compressed and uncompressed fields", () => {
  const half = Buffer.alloc(MAX_PAYLOAD_BYTES / 2, 65);
  expect(() =>
    parseGgep(block(compressedItem(half, false), compressedItem(half))),
  ).not.toThrow();
  const plain = encodeGgep([{ id: "Y", data: Buffer.from("a") }]).subarray(
    1,
  );
  expect(() =>
    parseGgep(
      block(
        compressedItem(half, false),
        compressedItem(half, false),
        plain,
      ),
    ),
  ).toThrow("decoded GGEP block too large");
});
