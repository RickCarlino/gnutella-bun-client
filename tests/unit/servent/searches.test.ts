import { expect, test } from "bun:test";
import { TYPE } from "../../../src/const";
import type { GnutellaEvent } from "../../../src/types";
import {
  buildHeader,
  encodeQueryHit,
  parseHeader,
} from "../../../src/wire/codec";
import {
  makeNode,
  makePeer,
  makeShare,
  withTempDir,
} from "../../helpers/protocol";

test("clearing one search drops late hits while other searches and relays continue", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`, {
      runtimeConfig: { nodeMode: "ultrapeer" },
    });
    const source = makePeer("source");
    const target = makePeer("target");
    source.role = target.role = "ultrapeer";
    node.connections.peers.set(source.key, source);
    node.connections.peers.set(target.key, target);
    const events: GnutellaEvent[] = [];
    node.subscribe((event) => events.push(event));
    const a = node.sendQuery("alpha")!;
    const b = node.sendQuery("beta")!;
    function reply(id: string, name: string) {
      const payload = encodeQueryHit(
        6346,
        "127.0.0.1",
        512,
        [makeShare(1, `/synthetic/${name}`, name)],
        Buffer.alloc(16, 2),
      );
      const header = parseHeader(
        buildHeader(Buffer.from(id, "hex"), TYPE.QUERY_HIT, 3, 1, payload),
      );
      node.router.handleDescriptor(source, header, payload);
    }
    reply(b.id, "beta.txt");
    reply(a.id, "alpha.txt");
    expect(node.getResults(a.id).map((hit) => hit.fileName)).toEqual([
      "alpha.txt",
    ]);
    expect(node.getResults(b.id).map((hit) => hit.fileName)).toEqual([
      "beta.txt",
    ]);
    node.clearResults(a.id);
    events.length = 0;
    reply(a.id, "late-alpha.txt");
    reply(b.id, "beta-new.txt");
    const hits = events.filter((event) => event.type === "QUERY_RESULT");
    expect(hits.map((event) => event.hit.queryIdHex)).toEqual([b.id]);
    expect(node.getResults(b.id)).toHaveLength(2);
    const remote = "cc".repeat(16);
    node.router.queryRoutes.set(remote, {
      peerKey: target.key,
      ts: node.now(),
    });
    events.length = 0;
    reply(remote, "relayed.txt");
    expect(events.some((event) => event.type === "QUERY_RESULT")).toBe(
      false,
    );
    expect(
      events.some(
        (event) =>
          event.type === "PEER_MESSAGE_SENT" &&
          event.payloadType === TYPE.QUERY_HIT &&
          event.peer.key === target.key,
      ),
    ).toBe(true);
    expect(node.getSearches().map((search) => search.id)).toEqual([b.id]);
  });
});
