import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, ts, walkFilesIter } from "../shared";
import {
  buildShareCatalog,
  shareMatchesCatalogEntry,
  withShareHash,
  type ShareCatalogFile,
  type ShareCatalogHash,
} from "../share_catalog";
import type { ShareFile } from "../types";
import { sha1ToUrn } from "./content_urn";
import { sha1File } from "./file_hash";
import type { GnutellaServent } from "./node";
import {
  loadShareIndex,
  writeShareIndex,
  type ShareIndexEntry,
} from "./share_index";

function rebuildShareState(
  node: GnutellaServent,
  shares: ShareFile[],
): void {
  node.shares = shares;
  node.sharesByIndex = new Map(
    shares.map((share) => [share.index, share]),
  );
  node.sharesByUrn = new Map(
    shares.flatMap((share) =>
      share.sha1Urn ? [[share.sha1Urn.toLowerCase(), share]] : [],
    ),
  );
  node.qrpTable.rebuildFromShares(shares);
}

export async function persistShareIndex(
  node: GnutellaServent,
): Promise<void> {
  await writeShareIndex(node.config().dataDir, node.shareIndexEntries);
}

function persistShareIndexLater(node: GnutellaServent): void {
  void persistShareIndex(node).catch((e) =>
    node.emitMaintenanceError("SAVE", e),
  );
}

async function loadShareIndexOnce(node: GnutellaServent): Promise<void> {
  if (node.shareIndexLoaded) return;
  node.shareIndexEntries = await loadShareIndex(node.config().dataDir);
  node.shareIndexLoaded = true;
}

function staleShareHashPass(
  node: GnutellaServent,
  generation: number,
): boolean {
  return node.stopped || generation !== node.shareRefreshGeneration;
}

function shareMatchesIndexEntry(
  share: Pick<ShareFile, "size" | "mtimeMs">,
  entry: ShareIndexEntry | undefined,
): entry is ShareIndexEntry {
  return shareMatchesCatalogEntry(share, entry);
}

async function fileStillMatchesShare(
  share: Pick<ShareFile, "abs" | "size" | "mtimeMs">,
): Promise<boolean> {
  const st = await fsp.stat(share.abs);
  return (
    st.isFile() && st.size === share.size && st.mtimeMs === share.mtimeMs
  );
}

function currentIndexedShare(
  node: GnutellaServent,
  pendingShare: ShareFile,
):
  | {
      share: ShareFile;
      entry: ShareIndexEntry;
    }
  | undefined {
  const share = node.sharesByIndex.get(pendingShare.index);
  const entry = node.shareIndexEntries.get(pendingShare.rel);
  if (!share || share.rel !== pendingShare.rel) return undefined;
  if (!shareMatchesIndexEntry(pendingShare, entry)) return undefined;
  return { share, entry };
}

function applyShareHash(
  node: GnutellaServent,
  share: ShareFile,
  entry: ShareIndexEntry,
  sha1: Buffer,
): void {
  const hash: ShareCatalogHash = {
    sha1,
    sha1Hex: sha1.toString("hex"),
    sha1Urn: sha1ToUrn(sha1),
  };
  const updated = withShareHash(share, entry, hash);
  share.sha1 = updated.share.sha1;
  share.sha1Urn = updated.share.sha1Urn;
  entry.sha1Hex = updated.entry.sha1Hex;
  entry.sha1Urn = updated.entry.sha1Urn;
  node.sharesByUrn.set(hash.sha1Urn.toLowerCase(), share);
}

async function hashPendingShare(
  node: GnutellaServent,
  pendingShare: ShareFile,
  generation: number,
): Promise<"continue" | "stop"> {
  if (staleShareHashPass(node, generation)) return "stop";
  const entry = node.shareIndexEntries.get(pendingShare.rel);
  if (!shareMatchesIndexEntry(pendingShare, entry)) return "continue";
  try {
    if (!(await fileStillMatchesShare(pendingShare))) return "continue";
    const sha1 = await sha1File(pendingShare.abs);
    if (staleShareHashPass(node, generation)) return "stop";
    const current = currentIndexedShare(node, pendingShare);
    if (!current) return "continue";
    applyShareHash(node, current.share, current.entry, sha1);
  } catch {
    // Files can be deleted or rewritten while hashing. The next rescan fixes
    // metadata and retries the hash when appropriate.
  }
  return "continue";
}

async function hashPendingShares(
  node: GnutellaServent,
  pendingShares: ShareFile[],
  generation: number,
): Promise<void> {
  for (const pendingShare of pendingShares) {
    if (
      (await hashPendingShare(node, pendingShare, generation)) === "stop"
    )
      return;
  }
  if (pendingShares.length === 0 || staleShareHashPass(node, generation)) {
    return;
  }
  try {
    await persistShareIndex(node);
  } catch (e) {
    node.emitMaintenanceError("SAVE", e);
  }
}

export async function refreshShares(node: GnutellaServent): Promise<void> {
  await loadShareIndexOnce(node);
  await ensureDir(node.config().downloadsDir);
  const downloadsDir = node.config().downloadsDir;
  const files: ShareCatalogFile[] = [];
  const generation = node.shareRefreshGeneration + 1;
  node.shareRefreshGeneration = generation;
  for await (const abs of walkFilesIter(downloadsDir)) {
    const st = await fsp.stat(abs);
    const rel = path.relative(downloadsDir, abs).replace(/\\/g, "/");
    files.push({
      rel,
      abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  const catalog = buildShareCatalog(files, node.shareIndexEntries);
  node.shareIndexEntries = catalog.entries;
  rebuildShareState(node, catalog.shares);
  node.emitEvent({
    type: "SHARES_REFRESHED",
    at: ts(),
    count: node.shares.length,
    totalKBytes: node.totalSharedKBytes(),
  });
  if (node.config().enableQrp) {
    for (const peer of node.peers.values()) {
      void node.sendQrpTable(peer).catch(() => void 0);
    }
  }
  persistShareIndexLater(node);
  if (catalog.pendingHashes.length === 0) {
    node.shareHashTask = null;
    return;
  }
  const task = hashPendingShares(node, catalog.pendingHashes, generation)
    .catch((e) => node.emitMaintenanceError("SHARE_RESCAN", e))
    .finally(() => {
      if (node.shareHashTask === task) node.shareHashTask = null;
    });
  node.shareHashTask = task;
}

export function totalSharedKBytes(node: GnutellaServent): number {
  return Math.ceil(node.shares.reduce((a, x) => a + x.size, 0) / 1024);
}
