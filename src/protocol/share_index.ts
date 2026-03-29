import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, fileExists } from "../shared";

const SHARE_INDEX_FILENAME = "share-index.json";
const SHARE_INDEX_VERSION = 1;

export type ShareIndexEntry = {
  rel: string;
  size: number;
  mtimeMs: number;
  sha1Hex?: string;
  sha1Urn?: string;
};

type ShareIndexManifest = {
  version?: unknown;
  files?: unknown;
};

function shareIndexPath(dataDir: string): string {
  return path.join(dataDir, SHARE_INDEX_FILENAME);
}

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

function parseShareIndexEntry(
  value: unknown,
): ShareIndexEntry | undefined {
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

export async function loadShareIndex(
  dataDir: string,
): Promise<Map<string, ShareIndexEntry>> {
  const file = shareIndexPath(dataDir);
  if (!(await fileExists(file))) return new Map();
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ShareIndexManifest;
    if (parsed.version !== SHARE_INDEX_VERSION) return new Map();
    if (!Array.isArray(parsed.files)) return new Map();
    const entries = parsed.files
      .map((value) => parseShareIndexEntry(value))
      .filter((entry) => entry !== undefined);
    return new Map(entries.map((entry) => [entry.rel, entry]));
  } catch {
    return new Map();
  }
}

export async function writeShareIndex(
  dataDir: string,
  entries: Map<string, ShareIndexEntry>,
): Promise<void> {
  await ensureDir(dataDir);
  const file = shareIndexPath(dataDir);
  const tmp = `${file}.tmp`;
  const manifest = {
    version: SHARE_INDEX_VERSION,
    files: [...entries.values()].sort((a, b) =>
      a.rel.localeCompare(b.rel),
    ),
  };
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fsp.rename(tmp, file);
}
