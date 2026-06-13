import type { ShareCatalogEntry } from "./types";

const SHARE_INDEX_VERSION = 1;

type ShareIndexManifest = {
  version?: unknown;
  files?: unknown;
};

type ShareCatalogManifest = {
  version: 1;
  files: ShareCatalogEntry[];
};

function objectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function validSha1Hex(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && /^[0-9a-f]{40}$/i.test(text)
    ? text.toLowerCase()
    : undefined;
}

function parseShareCatalogEntry(
  value: unknown,
): ShareCatalogEntry | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const rel = nonEmptyString(record.rel);
  const size = nonNegativeNumber(record.size);
  const mtimeMs = nonNegativeNumber(record.mtimeMs);
  if (!rel || size == null || mtimeMs == null) return undefined;
  const sha1Hex = validSha1Hex(record.sha1Hex);
  const sha1Urn = nonEmptyString(record.sha1Urn);
  return {
    rel,
    size,
    mtimeMs,
    ...(sha1Hex ? { sha1Hex } : {}),
    ...(sha1Urn ? { sha1Urn } : {}),
  };
}

export function parseShareCatalogManifest(
  value: unknown,
): Map<string, ShareCatalogEntry> {
  const parsed = objectRecord(value) as ShareIndexManifest | undefined;
  if (!parsed) return new Map();
  if (parsed.version !== SHARE_INDEX_VERSION) return new Map();
  if (!Array.isArray(parsed.files)) return new Map();
  const entries = parsed.files
    .map((entry) => parseShareCatalogEntry(entry))
    .filter((entry) => entry !== undefined);
  return new Map(entries.map((entry) => [entry.rel, entry]));
}

export function serializeShareCatalogManifest(
  entries: ReadonlyMap<string, ShareCatalogEntry>,
): ShareCatalogManifest {
  return {
    version: SHARE_INDEX_VERSION,
    files: [...entries.values()].sort((a, b) =>
      a.rel.localeCompare(b.rel),
    ),
  };
}
