import type { SearchHit } from "../../src/types";
import { makePeer } from "./protocol";
import type { TestServent } from "./servent";

/** Seed a real search session through its transport and ingestion seams. */
export function seedSearch(node: TestServent, hits: SearchHit[]) {
  const peer = makePeer("search-fixture");
  node.connections.peers.set(peer.key, peer);
  let session;
  try {
    session = node.sendQuery("fixture")!;
  } finally {
    node.connections.peers.delete(peer.key);
  }
  for (const hit of hits) {
    node.search.ingest(
      {
        queryIdHex: session.id,
        queryHops: hit.queryHops,
        viaPeerKey: hit.viaPeerKey,
      },
      {
        hits: 1,
        serventId: Buffer.from(hit.serventIdHex, "hex"),
        port: hit.remotePort,
        ip: hit.remoteHost,
        speedKBps: hit.speedKBps,
        serventIdHex: hit.serventIdHex,
        vendorCode: hit.vendorCode,
        flagPush: hit.needsPush,
        flagBusy: hit.busy,
        results: [
          {
            rawExtension: Buffer.alloc(0),
            fileIndex: hit.fileIndex,
            fileName: hit.fileName,
            fileSize: hit.fileSize,
            urns: hit.urns ?? (hit.sha1Urn ? [hit.sha1Urn] : []),
            metadata: hit.metadata ?? [],
          },
        ],
      },
    );
  }
  return session;
}
