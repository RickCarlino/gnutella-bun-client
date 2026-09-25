import { expect, test } from "bun:test";
import { SearchService } from "../../../src/search/service";
import type { GnutellaEvent } from "../../../src/types";
import { encodeQueryHit, parseQueryHit } from "../../../src/wire/codec";
import { makeShare } from "../../helpers/protocol";

function packet(name = "alpha.txt") {
  return parseQueryHit(
    encodeQueryHit(
      6346,
      "127.0.0.1",
      512,
      [makeShare(1, `/synthetic/${name}`, name)],
      Buffer.alloc(16, 2),
    ),
  );
}

function fixture() {
  const events: GnutellaEvent[] = [];
  const released: string[] = [];
  const pending = new Map<
    string,
    { resolve: (count: number) => void; reject: (error: Error) => void }
  >();
  const service = new SearchService({
    emit: (event) => events.push(event),
    now: () => 1234,
    sendQuery: (id, search) => {
      if (search === "offline") return false;
      if (search === "broken") throw new Error("send failed");
      // A synchronous response must be associated before sendQuery returns.
      ingest(id.toString("hex"));
      return true;
    },
    browse: (_target, id) =>
      new Promise((resolve, reject) =>
        pending.set(id.toString("hex"), { resolve, reject }),
      ),
    releaseQuery: (id) => released.push(id),
  });
  function ingest(id: string, name = "alpha.txt") {
    service.ingest(
      { queryIdHex: id, queryHops: 2, viaPeerKey: "p1" },
      packet(name),
    );
  }
  return { service, events, released, pending, ingest };
}

test("identical parallel queries own separate results and detached metadata", () => {
  const { service, ingest, events } = fixture();
  const a = service.query("alpha")!;
  const b = service.query("alpha")!;
  expect(a.id).not.toBe(b.id);
  expect(a.createdAt).toBe(1234);
  ingest(b.id, "b.txt");
  ingest(a.id, "a.txt");
  expect(service.snapshot(a.id).map((hit) => hit.fileName)).toEqual([
    "alpha.txt",
    "a.txt",
  ]);
  expect(service.snapshot(b.id).map((hit) => hit.fileName)).toEqual([
    "alpha.txt",
    "b.txt",
  ]);
  expect(service.list().map((search) => search.resultCount)).toEqual([
    2, 2,
  ]);
  expect(service.resultCount).toBe(4);
  const copy = service.snapshot(a.id);
  copy[0]!.fileName = "changed";
  a.search = "changed";
  service.list()[0]!.status = "failed";
  const event = events[0]!;
  if (event.type === "QUERY_RESULT") event.hit.fileName = "changed";
  expect(service.resolve(copy[0]!.resultNo).fileName).toBe("alpha.txt");
  expect(service.list()[0]).toMatchObject({
    search: "alpha",
    status: "active",
  });
});

test("clearing a search releases its route, ignores late hits, and preserves other results", () => {
  const { service, ingest, released, events } = fixture();
  const a = service.query("alpha")!;
  const b = service.query("beta")!;
  const queuedSource = service.resolve(1);
  service.clear(a.id);
  expect(() => service.resolve(1)).toThrow("no such result 1");
  expect(service.snapshot(b.id)).toHaveLength(1);
  const before = events.length;
  ingest(a.id);
  ingest("unknown");
  expect(events).toHaveLength(before);
  expect(released).toEqual([a.id]);
  expect(service.list().map((search) => search.id)).toEqual([b.id]);
  expect(() => service.snapshot(a.id)).toThrow("no such search");
  expect(() => service.clear(a.id)).toThrow("no such search");
  expect(queuedSource.fileName).toBe("alpha.txt");
  ingest(b.id);
  expect(service.snapshot(b.id).map((hit) => hit.resultNo)).toEqual([
    2, 3,
  ]);
  service.clear();
  expect(service.list()).toEqual([]);
  expect(released).toEqual([a.id, b.id]);
  const again = service.query("alpha")!;
  expect(again.number).toBeGreaterThan(b.number);
  expect(service.snapshot(again.id)[0]!.resultNo).toBe(4);
});

test("retention cannot evict results from quieter sessions", () => {
  const { service, ingest } = fixture();
  const quiet = service.query("quiet")!;
  const busy = service.query("busy")!;
  for (let i = 0; i < 1005; i++) ingest(busy.id);
  service.prune();
  expect(service.snapshot(quiet.id)[0]!.resultNo).toBe(1);
  expect(service.snapshot(busy.id)).toHaveLength(1000);
  expect(service.resultCount).toBe(1001);
});

test("skipped and failed transmissions release their sessions", () => {
  const { service, released } = fixture();
  expect(service.query("offline")).toBeUndefined();
  expect(() => service.query("broken")).toThrow("send failed");
  expect(service.list()).toEqual([]);
  expect(released).toHaveLength(2);
});

test("concurrent browse operations are isolated from queries and each other", async () => {
  const { service, pending, ingest } = fixture();
  const query = service.query("alpha")!;
  const first = service.browse("peer-a");
  const second = service.browse("peer-b");
  const [, a, b] = service.list();
  ingest(b!.id, "b.txt");
  ingest(a!.id, "a.txt");
  pending.get(b!.id)!.resolve(1);
  expect(await second).toMatchObject({
    id: b!.id,
    status: "complete",
    resultCount: 1,
  });
  pending.get(a!.id)!.resolve(1);
  expect(await first).toMatchObject({
    id: a!.id,
    status: "complete",
    resultCount: 1,
  });
  expect(service.snapshot(query.id).map((hit) => hit.fileName)).toEqual([
    "alpha.txt",
  ]);
  expect(service.snapshot(a!.id).map((hit) => hit.fileName)).toEqual([
    "a.txt",
  ]);
  expect(service.snapshot(b!.id).map((hit) => hit.fileName)).toEqual([
    "b.txt",
  ]);
});

test("empty, failed, and cleared in-flight browses have explicit lifetimes", async () => {
  const { service, pending, ingest } = fixture();
  const empty = service.browse("empty");
  const a = service.list()[0]!;
  pending.get(a.id)!.resolve(0);
  expect(await empty).toMatchObject({
    status: "complete",
    resultCount: 0,
  });
  const failed = service.browse("failed");
  const b = service.list()[1]!;
  pending.get(b.id)!.reject(new Error("browse failed"));
  await expect(failed).rejects.toThrow("browse failed");
  expect(service.list()[1]).toMatchObject({
    status: "failed",
    error: "browse failed",
  });
  const cleared = service.browse("cleared");
  const c = service.list()[2]!;
  service.clear(c.id);
  ingest(c.id);
  pending.get(c.id)!.resolve(1);
  await expect(cleared).rejects.toThrow("search cleared during browse");
  expect(service.list()).toHaveLength(2);
});
