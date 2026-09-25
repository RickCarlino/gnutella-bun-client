import { ts } from "../shared";
import type { GnutellaEventListener, SearchHit } from "../types";
import { parseQueryHit } from "../wire/codec";
import { firstSha1Urn } from "../wire/content_urn";

type ResultOrigin = {
  queryIdHex: string;
  queryHops: number;
  viaPeerKey: string;
};

/** Stores numbered search results and emits result events. */
export class SearchResults {
  private results: SearchHit[] = [];

  /** Attach the result event listener. */
  constructor(
    private readonly emit: GnutellaEventListener,
    private readonly allocateResultNo: () => number,
  ) {}

  /** Number incoming hits, retain them, and emit events. */
  ingest(
    origin: ResultOrigin,
    packet: ReturnType<typeof parseQueryHit>,
  ): void {
    for (const result of packet.results) {
      const hit: SearchHit = {
        resultNo: this.allocateResultNo(),
        ...origin,
        remoteHost: packet.ip,
        remotePort: packet.port,
        speedKBps: packet.speedKBps,
        fileIndex: result.fileIndex,
        fileName: result.fileName,
        fileSize: result.fileSize,
        serventIdHex: packet.serventIdHex,
        sha1Urn: firstSha1Urn(result.urns),
        urns: [...result.urns],
        metadata: [...result.metadata],
        vendorCode: packet.vendorCode,
        needsPush: packet.flagPush,
        busy: packet.flagBusy,
      };
      this.results.push(hit);
      this.emit({
        type: "QUERY_RESULT",
        at: ts(),
        hit: structuredClone(hit),
      });
    }
  }

  /** Count retained results without copying them. */
  get count(): number {
    return this.results.length;
  }

  /** Return detached copies of search results. */
  snapshot(): SearchHit[] {
    return structuredClone(this.results);
  }

  /** Find a numbered result in this session. */
  resolve(resultNo: number): SearchHit | undefined {
    const hit = this.results.find(
      (candidate) => candidate.resultNo === resultNo,
    );
    return hit && structuredClone(hit);
  }

  /** Keep only the newest thousand search results. */
  prune(): void {
    if (this.results.length > 1000)
      this.results = this.results.slice(-1000);
  }
}
