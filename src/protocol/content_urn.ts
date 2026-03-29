import { BASE32_ALPHABET } from "../const";

const BASE32_LOOKUP = new Map(
  [...BASE32_ALPHABET].map((char, index) => [char, index]),
);

const SHA1_URN_PREFIX = "urn:sha1:";
const BITPRINT_URN_PREFIX = "urn:bitprint:";
const TREE_TIGER_URN_PREFIX = "urn:tree:tiger/:";

function normalizeSha1Base32(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z2-7]{32}$/.test(normalized) ? normalized : undefined;
}

function normalizeTigerTreeBase32(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z2-7]{39}$/.test(normalized) ? normalized : undefined;
}

function base32Decode(text: string): Buffer | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase()) {
    const digit = BASE32_LOOKUP.get(char);
    if (digit == null) return undefined;
    value = (value << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(data: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function normalizeSha1Urn(raw: string): string | undefined {
  const match = /^urn:sha1:([A-Z2-7]+)$/i.exec(raw.trim());
  if (!match) return undefined;
  const digest = normalizeSha1Base32(match[1]);
  return digest ? `${SHA1_URN_PREFIX}${digest}` : undefined;
}

function normalizeBitprintUrn(raw: string): string | undefined {
  const match = /^urn:bitprint:([A-Z2-7]+)\.([A-Z2-7]+)$/i.exec(
    raw.trim(),
  );
  if (!match) return undefined;
  const sha1 = normalizeSha1Base32(match[1]);
  const tiger = normalizeTigerTreeBase32(match[2]);
  if (!sha1 || !tiger) return undefined;
  return `${BITPRINT_URN_PREFIX}${sha1}.${tiger}`;
}

function normalizeTreeTigerUrn(raw: string): string | undefined {
  const match = /^urn:tree:tiger\/?:([A-Z2-7]+)$/i.exec(raw.trim());
  if (!match) return undefined;
  const tiger = normalizeTigerTreeBase32(match[1]);
  return tiger ? `${TREE_TIGER_URN_PREFIX}${tiger}` : undefined;
}

export function sha1UrnFromUrn(raw: string): string | undefined {
  const sha1 = normalizeSha1Urn(raw);
  if (sha1) return sha1;
  const bitprint = normalizeBitprintUrn(raw);
  if (!bitprint) return undefined;
  const dot = bitprint.indexOf(".");
  return dot === -1
    ? undefined
    : `${SHA1_URN_PREFIX}${bitprint.slice(BITPRINT_URN_PREFIX.length, dot)}`;
}

export function sha1BufferFromUrn(raw: string): Buffer | undefined {
  const sha1Urn = sha1UrnFromUrn(raw);
  if (!sha1Urn) return undefined;
  const digest = sha1Urn.slice(SHA1_URN_PREFIX.length);
  const decoded = base32Decode(digest);
  return decoded?.length === 20 ? decoded : undefined;
}

export function bitprintUrnFromHashes(
  sha1: Buffer,
  tigerTreeRoot: Buffer,
): string {
  return `${BITPRINT_URN_PREFIX}${base32Encode(sha1)}.${base32Encode(tigerTreeRoot)}`;
}

export function normalizeUrnList(rawUrns: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (urn: string) => {
    const key = urn.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(urn);
  };
  for (const raw of rawUrns) {
    const sha1 = normalizeSha1Urn(raw);
    if (sha1) {
      add(sha1);
      continue;
    }
    const bitprint = normalizeBitprintUrn(raw);
    if (bitprint) {
      add(bitprint);
      add(
        `${SHA1_URN_PREFIX}${bitprint.slice(
          BITPRINT_URN_PREFIX.length,
          bitprint.indexOf("."),
        )}`,
      );
      continue;
    }
    const tiger = normalizeTreeTigerUrn(raw);
    if (tiger) {
      add(tiger);
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("urn:")) add(trimmed);
  }
  return out;
}

export function firstSha1Urn(
  rawUrns: Iterable<string>,
): string | undefined {
  for (const urn of rawUrns) {
    const sha1 = sha1UrnFromUrn(urn);
    if (sha1) return sha1;
  }
}

export function textUrnFromGgepUrn(raw: Buffer): string | undefined {
  const text = raw.toString("utf8").trim();
  if (!text) return undefined;
  if (text.toLowerCase().startsWith("urn:")) {
    return normalizeUrnList([text])[0];
  }
  if (/^(sha1|bitprint|tree:tiger\/?):/i.test(text)) {
    return normalizeUrnList([`urn:${text}`])[0];
  }
}

export function bitprintUrnFromGgepHash(
  payload: Buffer,
): string | undefined {
  if (payload.length < 1 + 20 + 24) return undefined;
  return bitprintUrnFromHashes(
    payload.subarray(1, 21),
    payload.subarray(21, 45),
  );
}
