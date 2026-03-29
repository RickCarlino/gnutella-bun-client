import zlib from "node:zlib";

const GGEP_MAGIC = 0xc3;
const GGEP_HDR_LAST = 0x80;
const GGEP_HDR_COBS = 0x40;
const GGEP_HDR_DEFLATE = 0x20;
const GGEP_HDR_RESERVED = 0x10;
const GGEP_HDR_IDLEN = 0x0f;
const GGEP_LEN_MORE = 0x80;
const GGEP_LEN_LAST = 0x40;
const GGEP_LEN_MASK = 0x3f;

export type GgepItem = {
  id: string;
  data: Buffer;
};

function hasZeroByte(data: Buffer): boolean {
  return data.includes(0);
}

function cobsEncode(data: Buffer): Buffer {
  const out = [0];
  let codeIndex = 0;
  let code = 1;
  for (const byte of data) {
    if (byte === 0) {
      out[codeIndex] = code;
      codeIndex = out.length;
      out.push(0);
      code = 1;
      continue;
    }
    out.push(byte);
    code++;
    if (code === 0xff) {
      out[codeIndex] = code;
      codeIndex = out.length;
      out.push(0);
      code = 1;
    }
  }
  out[codeIndex] = code;
  return Buffer.from(out);
}

function cobsDecode(data: Buffer): Buffer {
  const out: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const code = data[offset++];
    if (code === 0) throw new Error("invalid GGEP COBS block");
    const next = offset + code - 1;
    if (next > data.length + 1)
      throw new Error("truncated GGEP COBS block");
    for (; offset < next && offset < data.length; offset++) {
      out.push(data[offset] as number);
    }
    if (code < 0xff && offset < data.length) out.push(0);
  }
  return Buffer.from(out);
}

function encodeLength(length: number): Buffer {
  const bytes: number[] = [];
  if (length & 0x3f000) {
    bytes.push(((length >>> 12) & GGEP_LEN_MASK) | GGEP_LEN_MORE);
  }
  if (length & 0x0fc0) {
    bytes.push(((length >>> 6) & GGEP_LEN_MASK) | GGEP_LEN_MORE);
  }
  bytes.push((length & GGEP_LEN_MASK) | GGEP_LEN_LAST);
  return Buffer.from(bytes);
}

function decodeLength(
  raw: Buffer,
  start: number,
): { length: number; nextOffset: number } {
  let offset = start;
  let length = 0;
  for (let i = 0; i < 3; i++) {
    const byte = raw[offset++];
    if (byte == null || byte === 0) throw new Error("invalid GGEP length");
    length = (length << 6) | (byte & GGEP_LEN_MASK);
    const last = !!(byte & GGEP_LEN_LAST);
    const more = !!(byte & GGEP_LEN_MORE);
    if (last) {
      if (more) throw new Error("invalid GGEP length flags");
      return { length, nextOffset: offset };
    }
    if (!more) throw new Error("invalid GGEP length continuation");
  }
  throw new Error("GGEP length too long");
}

function maybeDeflateDecode(data: Buffer, flags: number): Buffer {
  if (!(flags & GGEP_HDR_DEFLATE)) return data;
  return zlib.inflateRawSync(data);
}

function parseGgepItem(
  raw: Buffer,
  start: number,
): { item: GgepItem; nextOffset: number; last: boolean } {
  let offset = start;
  const flags = raw[offset++];
  if (flags == null) throw new Error("truncated GGEP flags");
  if ((flags & GGEP_HDR_RESERVED) !== 0)
    throw new Error("invalid GGEP reserved bit");
  const idLength = flags & GGEP_HDR_IDLEN;
  if (!idLength) throw new Error("invalid GGEP id length");
  if (offset + idLength > raw.length) throw new Error("truncated GGEP id");
  const id = raw.subarray(offset, offset + idLength).toString("ascii");
  offset += idLength;
  const decodedLength = decodeLength(raw, offset);
  offset = decodedLength.nextOffset;
  if (offset + decodedLength.length > raw.length)
    throw new Error("truncated GGEP payload");
  let data = Buffer.from(
    raw.subarray(offset, offset + decodedLength.length),
  ) as Buffer;
  offset += decodedLength.length;
  if (flags & GGEP_HDR_COBS) data = cobsDecode(data) as Buffer;
  data = maybeDeflateDecode(data, flags) as Buffer;
  return {
    item: { id, data },
    nextOffset: offset,
    last: !!(flags & GGEP_HDR_LAST),
  };
}

export function encodeGgep(items: GgepItem[]): Buffer {
  if (!items.length) return Buffer.alloc(0);
  const parts: Buffer[] = [Buffer.from([GGEP_MAGIC])];
  items.forEach((item, index) => {
    const id = item.id.trim();
    if (!id || id.length > 15)
      throw new Error(`invalid GGEP id ${JSON.stringify(item.id)}`);
    let flags = id.length;
    let data = item.data;
    if (hasZeroByte(data)) {
      data = cobsEncode(data);
      flags |= GGEP_HDR_COBS;
    }
    if (index === items.length - 1) flags |= GGEP_HDR_LAST;
    parts.push(
      Buffer.from([flags]),
      Buffer.from(id, "ascii"),
      encodeLength(data.length),
      data,
    );
  });
  return Buffer.concat(parts);
}

export function parseGgep(raw: Buffer): GgepItem[] {
  if (!raw.length || raw[0] !== GGEP_MAGIC) return [];
  const items: GgepItem[] = [];
  let offset = 1;
  while (offset < raw.length) {
    const parsed = parseGgepItem(raw, offset);
    items.push(parsed.item);
    offset = parsed.nextOffset;
    if (parsed.last) break;
  }
  return items;
}
