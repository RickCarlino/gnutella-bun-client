import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseShareCatalogManifest,
  serializeShareCatalogManifest,
  type ShareCatalogEntry,
} from ".";
import { ensureDir, fileExists } from "../shared";

const SHARE_INDEX_FILENAME = "share-index.json";
const shareIndexWriteQueues = new Map<string, Promise<void>>();

export type ShareIndexEntry = ShareCatalogEntry;

function shareIndexPath(dataDir: string): string {
  return path.join(dataDir, SHARE_INDEX_FILENAME);
}

function shareIndexTmpPath(file: string): string {
  return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function queueShareIndexWrite(
  file: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = shareIndexWriteQueues.get(file) || Promise.resolve();
  const current = previous.catch(() => void 0).then(task);
  shareIndexWriteQueues.set(file, current);
  try {
    await current;
  } finally {
    if (shareIndexWriteQueues.get(file) === current) {
      shareIndexWriteQueues.delete(file);
    }
  }
}

/** Load cached share metadata, falling back to an empty index. */
export async function loadShareIndex(
  dataDir: string,
): Promise<Map<string, ShareIndexEntry>> {
  const file = shareIndexPath(dataDir);
  if (!(await fileExists(file))) return new Map();
  try {
    const raw = await fsp.readFile(file, "utf8");
    return parseShareCatalogManifest(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

/** Serialize and atomically replace the cached share index. */
export async function writeShareIndex(
  dataDir: string,
  entries: Map<string, ShareIndexEntry>,
): Promise<void> {
  await ensureDir(dataDir);
  const file = shareIndexPath(dataDir);
  const manifest = serializeShareCatalogManifest(entries);
  await queueShareIndexWrite(file, async () => {
    const tmp = shareIndexTmpPath(file);
    try {
      await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
      await fsp.rename(tmp, file);
    } finally {
      await fsp.unlink(tmp).catch(() => void 0);
    }
  });
}
