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
export class SearchService {
  results: SearchHit[] = [];
  nextResultNo = 1;

  /** Attach the result event listener. */
  constructor(private readonly emit: GnutellaEventListener) {}

  /** Number incoming hits, retain them, and emit events. */
  ingest(
    origin: ResultOrigin,
    packet: ReturnType<typeof parseQueryHit>,
  ): void {
    for (const result of packet.results) {
      const hit: SearchHit = {
        resultNo: this.nextResultNo++,
        ...origin,
        remoteHost: packet.ip,
        remotePort: packet.port,
        speedKBps: packet.speedKBps,
        fileIndex: result.fileIndex,
        fileName: result.fileName,
        fileSize: result.fileSize,
        serventIdHex: packet.serventIdHex,
        sha1Urn: firstSha1Urn(result.urns),
        urns: result.urns,
        metadata: result.metadata,
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

  /** Return detached copies of search results. */
  snapshot(): SearchHit[] {
    return structuredClone(this.results);
  }

  /** Find a numbered result or throw if absent. */
  resolve(resultNo: number): SearchHit {
    const hit = this.results.find(
      (candidate) => candidate.resultNo === resultNo,
    );
    if (!hit) throw new Error(`no such result ${resultNo}`);
    return structuredClone(hit);
  }

  /** Remove all results and restart result numbering. */
  clear(): void {
    this.results = [];
    this.nextResultNo = 1;
  }

  /** Keep only the newest thousand search results. */
  prune(): void {
    if (this.results.length > 1000)
      this.results = this.results.slice(-1000);
  }
}
