import { errMsg } from "../shared";
import type { GnutellaEventListener, SearchHit } from "../types";
import { randomId16 } from "../wire/ids";
import { SearchResults } from "./results";
import type { SearchSession } from "./types";

type SearchDependencies = {
  emit: GnutellaEventListener;
  now: () => number;
  sendQuery: (id: Buffer, search: string, ttl?: number) => boolean;
  browse: (target: string, id: Buffer) => Promise<number>;
  releaseQuery: (id: string) => void;
};

type SessionState = {
  summary: SearchSession;
  results: SearchResults;
};

/** Owns search lifetimes and isolated result sets. */
export class SearchService {
  private readonly sessions = new Map<string, SessionState>();
  private nextSessionNo = 1;
  private nextResultNo = 1;

  /** Attach transport actions without owning sockets or routes. */
  constructor(private readonly deps: SearchDependencies) {}

  private create(
    kind: SearchSession["kind"],
    search: string,
  ): SessionState {
    const state: SessionState = {
      summary: {
        id: randomId16().toString("hex"),
        number: this.nextSessionNo++,
        kind,
        search,
        createdAt: this.deps.now(),
        status: "active",
        resultCount: 0,
      },
      results: new SearchResults(
        this.deps.emit,
        () => this.nextResultNo++,
      ),
    };
    this.sessions.set(state.summary.id, state);
    return state;
  }

  /** Register before transmitting so even immediate replies have an owner. */
  query(search: string, ttl?: number): SearchSession | undefined {
    const state = this.create("query", search);
    const id = state.summary.id;
    try {
      if (!this.deps.sendQuery(Buffer.from(id, "hex"), search, ttl)) {
        this.clear(id);
        return undefined;
      }
      if (!this.sessions.has(id))
        throw new Error("search cleared during query");
      return this.describe(state);
    } catch (error) {
      if (this.sessions.has(id)) this.clear(id);
      throw error;
    }
  }

  /** Keep each browse operation, including failed or empty ones, separate. */
  async browse(target: string): Promise<SearchSession> {
    const state = this.create("browse", target);
    try {
      await this.deps.browse(target, Buffer.from(state.summary.id, "hex"));
      if (!this.sessions.has(state.summary.id))
        throw new Error("search cleared during browse");
      state.summary.status = "complete";
      return this.describe(state);
    } catch (error) {
      state.summary.status = "failed";
      state.summary.error = errMsg(error);
      throw error;
    }
  }

  /** Ignore unknown or cleared searches, including late network replies. */
  ingest(...args: Parameters<SearchResults["ingest"]>): void {
    const state = this.sessions.get(args[0].queryIdHex);
    if (state?.summary.status !== "active") return;
    for (const result of args[1].results) {
      if (!this.sessions.has(args[0].queryIdHex)) break;
      state.results.ingest(args[0], { ...args[1], results: [result] });
    }
  }

  private describe(state: SessionState): SearchSession {
    return { ...state.summary, resultCount: state.results.count };
  }

  private require(id: string): SessionState {
    const state = this.sessions.get(id);
    if (!state) throw new Error(`no such search ${id}`);
    return state;
  }

  /** List detached summaries in creation order. */
  list(): SearchSession[] {
    return [...this.sessions.values()].map((state) =>
      this.describe(state),
    );
  }

  /** Read one result set; there is deliberately no aggregate result bucket. */
  snapshot(id: string): SearchHit[] {
    return this.require(id).results.snapshot();
  }

  /** Resolve a stable result number for a download. */
  resolve(resultNo: number): SearchHit {
    for (const state of this.sessions.values()) {
      const hit = state.results.resolve(resultNo);
      if (hit) return hit;
    }
    throw new Error(`no such result ${resultNo}`);
  }

  /** Remove one or all searches and release their local return routes. */
  clear(id?: string): void {
    if (id !== undefined) this.require(id);
    const ids = id === undefined ? [...this.sessions.keys()] : [id];
    for (const searchId of ids) {
      this.sessions.delete(searchId);
      this.deps.releaseQuery(searchId);
    }
  }

  /** Apply retention independently so busy searches cannot evict quiet ones. */
  prune(): void {
    for (const state of this.sessions.values()) state.results.prune();
  }

  /** Count retained results across sessions for node status. */
  get resultCount(): number {
    let count = 0;
    for (const state of this.sessions.values())
      count += state.results.count;
    return count;
  }
}
