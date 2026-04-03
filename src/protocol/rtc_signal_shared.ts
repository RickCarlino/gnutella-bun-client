import { encodeGgep, parseGgep } from "./ggep";

type TlvMap = Map<number, Buffer[]>;

export function encodeSingleGgep(
  id: string,
  fields: Array<{ type: number; value: Buffer }>,
): Buffer {
  return encodeGgep([{ id, data: encodeTlv(fields) }]);
}

export function readSingleGgep(raw: Buffer, id: string): Buffer {
  const ggepStart = raw.indexOf(0xc3);
  if (ggepStart === -1) throw new Error(`missing ${id} GGEP block`);
  const match = parseGgep(raw.subarray(ggepStart)).find(
    (item) => item.id === id,
  );
  if (!match) throw new Error(`missing ${id} GGEP block`);
  return match.data;
}

function encodeTlv(
  fields: Array<{ type: number; value: Buffer }>,
): Buffer {
  return Buffer.concat(
    fields.map((field) =>
      Buffer.concat([
        Buffer.from([field.type & 0xff]),
        encodeUleb128(field.value.length),
        field.value,
      ]),
    ),
  );
}

export function parseTlv(raw: Buffer): TlvMap {
  const fields = new Map<number, Buffer[]>();
  let offset = 0;
  while (offset < raw.length) {
    const type = raw[offset++];
    const { bytesRead, value: length } = decodeUleb128(raw, offset);
    offset += bytesRead;
    if (offset + length > raw.length) {
      throw new Error("truncated TLV field");
    }
    const value = Buffer.from(raw.subarray(offset, offset + length));
    offset += length;
    const existing = fields.get(type);
    if (existing) existing.push(value);
    else fields.set(type, [value]);
  }
  return fields;
}

export function integerField(
  type: number,
  value: number,
): { type: number; value: Buffer } {
  return {
    type,
    value: encodeUleb128(value),
  };
}

export function binaryField(
  type: number,
  value: Buffer,
): { type: number; value: Buffer } {
  return {
    type,
    value: Buffer.from(value),
  };
}

export function readSingleField(
  fields: TlvMap,
  type: number,
  label: string,
): Buffer {
  const values = fields.get(type);
  if (!values?.length) throw new Error(`missing ${label}`);
  return values[0];
}

export function readIntegerField(
  fields: TlvMap,
  type: number,
  label: string,
): number {
  const value = readSingleField(fields, type, label);
  return decodeUleb128(value, 0).value;
}

export function readRepeatedBinaryFields(
  fields: TlvMap,
  type: number,
): Buffer[] {
  return (fields.get(type) || []).map((value) => Buffer.from(value));
}

export function requireBufferLength(
  value: Buffer,
  length: number,
  label: string,
): Buffer {
  if (value.length !== length) {
    throw new Error(
      `${label} must be ${length} bytes, got ${value.length}`,
    );
  }
  return value;
}

function encodeUleb128(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `ULEB128 value must be a non-negative integer, got ${value}`,
    );
  }
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function decodeUleb128(
  raw: Buffer,
  offset: number,
): { bytesRead: number; value: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < raw.length) {
    const byte = raw[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if (!(byte & 0x80)) return { bytesRead, value };
    shift += 7;
    if (shift > 28) throw new Error("ULEB128 value too large");
  }
  throw new Error("truncated ULEB128 value");
}
