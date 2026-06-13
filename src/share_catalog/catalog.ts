import path from "node:path";

import { shareKeywords } from "./keywords";
import type {
  ShareCatalogBuildResult,
  ShareCatalogEntry,
  ShareCatalogFile,
  ShareCatalogHash,
  ShareCatalogShare,
  ShareHashApplication,
} from "./types";

export function shareMatchesCatalogEntry(
  share: Pick<ShareCatalogShare, "size" | "mtimeMs">,
  entry: ShareCatalogEntry | undefined,
): entry is ShareCatalogEntry {
  return (
    !!entry && entry.size === share.size && entry.mtimeMs === share.mtimeMs
  );
}

export function cachedShareHash(
  entry: ShareCatalogEntry | undefined,
  size: number,
  mtimeMs: number,
): ShareCatalogHash | undefined {
  if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs)
    return undefined;
  if (!entry.sha1Hex || !entry.sha1Urn) return undefined;
  return {
    sha1: Buffer.from(entry.sha1Hex, "hex"),
    sha1Hex: entry.sha1Hex,
    sha1Urn: entry.sha1Urn,
  };
}

function catalogEntryForFile(
  file: ShareCatalogFile,
  hash?: Pick<ShareCatalogHash, "sha1Hex" | "sha1Urn">,
): ShareCatalogEntry {
  return {
    rel: file.rel,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...(hash ? { sha1Hex: hash.sha1Hex, sha1Urn: hash.sha1Urn } : {}),
  };
}

function shareRecordForFile(
  file: ShareCatalogFile,
  index: number,
  hash?: ShareCatalogHash,
): ShareCatalogShare {
  return {
    index,
    name: path.basename(file.abs),
    rel: file.rel,
    abs: file.abs,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...(hash ? { sha1: hash.sha1, sha1Urn: hash.sha1Urn } : {}),
    keywords: shareKeywords(file.abs, file.rel),
  };
}

export function withShareHash(
  share: ShareCatalogShare,
  entry: ShareCatalogEntry,
  hash: ShareCatalogHash,
): ShareHashApplication {
  return {
    share: {
      ...share,
      sha1: hash.sha1,
      sha1Urn: hash.sha1Urn,
    },
    entry: {
      ...entry,
      sha1Hex: hash.sha1Hex,
      sha1Urn: hash.sha1Urn,
    },
  };
}

export function buildShareCatalog(
  files: Iterable<ShareCatalogFile>,
  previousEntries: ReadonlyMap<string, ShareCatalogEntry>,
): ShareCatalogBuildResult {
  const shares: ShareCatalogShare[] = [];
  const entries = new Map<string, ShareCatalogEntry>();
  const pendingHashes: ShareCatalogShare[] = [];
  let index = 1;

  for (const file of files) {
    const cached = cachedShareHash(
      previousEntries.get(file.rel),
      file.size,
      file.mtimeMs,
    );
    const share = shareRecordForFile(file, index++, cached);
    const entry = catalogEntryForFile(file, cached);
    shares.push(share);
    entries.set(file.rel, entry);
    if (!cached) pendingHashes.push(share);
  }

  return { shares, entries, pendingHashes };
}
