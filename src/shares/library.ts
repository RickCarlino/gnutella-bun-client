import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildShareCatalog,
  shareMatchesCatalogEntry,
  withShareHash,
  type ShareCatalogFile,
  type ShareCatalogHash,
} from ".";
import { ensureDir, walkFilesIter } from "../shared";
import type { QueryDescriptor, ShareFile } from "../types";
import { sha1ToUrn } from "../wire/content_urn";
import { sha1File } from "./hash_file";
import { matchQuery } from "./query_matching";
import {
  loadShareIndex,
  writeShareIndex,
  type ShareIndexEntry,
} from "./store";

type ShareLibraryDependencies = {
  paths: () => { dataDir: string; downloadsDir: string };
  onCatalog: (shares: ShareFile[]) => void;
  onRefresh: (count: number, totalKBytes: number) => void;
  onError: (operation: "SAVE" | "SHARE_RESCAN", error: unknown) => void;
};

const defaultIo = {
  ensureDir,
  walk: walkFilesIter,
  stat: fsp.stat,
  hash: sha1File,
  load: loadShareIndex,
  write: writeShareIndex,
};

/** Owns shared-file discovery, indexing, and cached hashes. */
export class ShareLibrary {
  shares: ShareFile[] = [];
  sharesByIndex = new Map<number, ShareFile>();
  sharesByUrn = new Map<string, ShareFile>();
  private shareIndexEntries = new Map<string, ShareIndexEntry>();
  private shareIndexLoad: Promise<void> | undefined;
  private shareRefreshGeneration = 0;
  shareHashTask: Promise<void> | null = null;
  private stopped = false;
  private readonly io: typeof defaultIo;

  /** Attach share paths, callbacks, and optional file I/O. */
  constructor(
    private readonly deps: ShareLibraryDependencies,
    io: Partial<typeof defaultIo> = {},
  ) {
    this.io = { ...defaultIo, ...io };
  }

  /** Return detached copies of the current shared files. */
  list(): ShareFile[] {
    return this.shares.map((share) => ({
      ...share,
      keywords: [...share.keywords],
      ...(share.sha1 ? { sha1: Buffer.from(share.sha1) } : {}),
    }));
  }

  /** Look up a share by its protocol file index. */
  byIndex(index: number): ShareFile | undefined {
    return this.sharesByIndex.get(index);
  }

  /** Look up a share by its content URN, ignoring case. */
  byUrn(urn: string): ShareFile | undefined {
    return this.sharesByUrn.get(urn.toLowerCase());
  }

  /** Return local shares matching a query. */
  matches(query: QueryDescriptor): ShareFile[] {
    return this.shares.filter((share) => matchQuery(query, share));
  }

  /** Stop refresh work and invalidate pending hash passes. */
  dispose(): void {
    this.stopped = true;
    this.shareRefreshGeneration++;
  }

  private rebuildShareState(shares: ShareFile[]): void {
    this.shares = shares;
    this.sharesByIndex = new Map(
      shares.map((share) => [share.index, share]),
    );
    this.sharesByUrn = new Map(
      shares.flatMap((share) =>
        share.sha1Urn ? [[share.sha1Urn.toLowerCase(), share]] : [],
      ),
    );
    this.deps.onCatalog(shares);
  }

  /** Save cached share metadata and hashes. */
  async persistShareIndex(): Promise<void> {
    await this.io.write(this.deps.paths().dataDir, this.shareIndexEntries);
  }

  private persistShareIndexLater(): void {
    void this.persistShareIndex().catch((e) =>
      this.deps.onError("SAVE", e),
    );
  }

  private loadShareIndexOnce(): Promise<void> {
    this.shareIndexLoad ??= this.io
      .load(this.deps.paths().dataDir)
      .then((entries) => {
        this.shareIndexEntries = entries;
      })
      .catch((error: unknown) => {
        this.shareIndexLoad = undefined;
        throw error;
      });
    return this.shareIndexLoad;
  }

  private staleShareHashPass(generation: number): boolean {
    return this.stopped || generation !== this.shareRefreshGeneration;
  }

  private shareMatchesIndexEntry(
    share: Pick<ShareFile, "size" | "mtimeMs">,
    entry: ShareIndexEntry | undefined,
  ): entry is ShareIndexEntry {
    return shareMatchesCatalogEntry(share, entry);
  }

  private async fileStillMatchesShare(
    share: Pick<ShareFile, "abs" | "size" | "mtimeMs">,
  ): Promise<boolean> {
    const st = await this.io.stat(share.abs);
    return (
      st.isFile() && st.size === share.size && st.mtimeMs === share.mtimeMs
    );
  }

  private currentIndexedShare(pendingShare: ShareFile):
    | {
        share: ShareFile;
        entry: ShareIndexEntry;
      }
    | undefined {
    const share = this.sharesByIndex.get(pendingShare.index);
    const entry = this.shareIndexEntries.get(pendingShare.rel);
    if (!share || share.rel !== pendingShare.rel) return undefined;
    if (!this.shareMatchesIndexEntry(pendingShare, entry))
      return undefined;
    return { share, entry };
  }

  private applyShareHash(
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
    this.sharesByUrn.set(hash.sha1Urn.toLowerCase(), share);
  }

  private async hashPendingShare(
    pendingShare: ShareFile,
    generation: number,
  ): Promise<"continue" | "stop"> {
    if (this.staleShareHashPass(generation)) return "stop";
    const entry = this.shareIndexEntries.get(pendingShare.rel);
    if (!this.shareMatchesIndexEntry(pendingShare, entry))
      return "continue";
    try {
      if (!(await this.fileStillMatchesShare(pendingShare)))
        return "continue";
      const sha1 = await this.io.hash(pendingShare.abs);
      if (this.staleShareHashPass(generation)) return "stop";
      const current = this.currentIndexedShare(pendingShare);
      if (!current) return "continue";
      this.applyShareHash(current.share, current.entry, sha1);
    } catch {
      // Files can be deleted or rewritten while hashing. The next rescan fixes
      // metadata and retries the hash when appropriate.
    }
    return "continue";
  }

  private async hashPendingShares(
    pendingShares: ShareFile[],
    generation: number,
  ): Promise<void> {
    for (const pendingShare of pendingShares) {
      if (
        (await this.hashPendingShare(pendingShare, generation)) === "stop"
      )
        return;
    }
    if (
      pendingShares.length === 0 ||
      this.staleShareHashPass(generation)
    ) {
      return;
    }
    try {
      await this.persistShareIndex();
    } catch (e) {
      this.deps.onError("SAVE", e);
    }
  }

  /** Rescan shared files and refresh the published catalog. */
  async refreshShares(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.shareRefreshGeneration;
    await this.loadShareIndexOnce();
    await this.io.ensureDir(this.deps.paths().downloadsDir);
    const downloadsDir = this.deps.paths().downloadsDir;
    const files: ShareCatalogFile[] = [];
    if (this.staleShareHashPass(generation)) return;
    for await (const abs of this.io.walk(downloadsDir)) {
      const st = await this.io.stat(abs);
      const rel = path.relative(downloadsDir, abs).replace(/\\/g, "/");
      files.push({
        rel,
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
    if (this.staleShareHashPass(generation)) return;
    const catalog = buildShareCatalog(files, this.shareIndexEntries);
    this.shareIndexEntries = catalog.entries;
    this.rebuildShareState(catalog.shares);
    this.deps.onRefresh(this.shares.length, this.totalSharedKBytes());
    this.persistShareIndexLater();
    if (catalog.pendingHashes.length === 0) {
      this.shareHashTask = null;
      return;
    }
    const task = this.hashPendingShares(catalog.pendingHashes, generation)
      .catch((e) => this.deps.onError("SHARE_RESCAN", e))
      .finally(() => {
        if (this.shareHashTask === task) this.shareHashTask = null;
      });
    this.shareHashTask = task;
  }

  /** Return the total shared size rounded up to kilobytes. */
  totalSharedKBytes(): number {
    return Math.ceil(this.shares.reduce((a, x) => a + x.size, 0) / 1024);
  }
}
