import { expect, test } from "bun:test";
import { SearchResults } from "../../../src/search/results";
import type { GnutellaEvent } from "../../../src/types";
import { encodeQueryHit, parseQueryHit } from "../../../src/wire/codec";
import { makeShare } from "../../helpers/protocol";

const origin = {
  queryIdHex: "11".repeat(16),
  queryHops: 2,
  viaPeerKey: "p1",
};

function packet() {
  return parseQueryHit(
    encodeQueryHit(
      6346,
      "127.0.0.1",
      512,
      [makeShare(1, "/synthetic/alpha.txt", "alpha.txt")],
      Buffer.alloc(16, 2),
    ),
  );
}

test("search owns numbering, detached results, and event values", () => {
  const events: GnutellaEvent[] = [];
  let next = 1;
  const search = new SearchResults(
    (event) => events.push(event),
    () => next++,
  );
  search.ingest(origin, packet());
  search.ingest(origin, packet());
  expect(search.snapshot().map((hit) => hit.resultNo)).toEqual([1, 2]);
  const snapshot = search.snapshot();
  snapshot[0]!.fileName = "changed";
  const event = events[0]!;
  if (event.type === "QUERY_RESULT") event.hit.fileName = "changed again";
  expect(search.resolve(1)!.fileName).toBe("alpha.txt");
  expect(search.resolve(99)).toBeUndefined();
  search.ingest(origin, packet());
  expect(search.resolve(3)!.queryHops).toBe(2);
});

test("retention runs during maintenance without renumbering retained hits", () => {
  let next = 1;
  const search = new SearchResults(
    () => {},
    () => next++,
  );
  const hit = packet();
  for (let i = 0; i < 1005; i++) search.ingest(origin, hit);
  expect(search.snapshot()).toHaveLength(1005);
  search.prune();
  expect(search.snapshot()).toHaveLength(1000);
  expect(search.snapshot()[0]?.resultNo).toBe(6);
  search.ingest(origin, hit);
  expect(search.resolve(1006)!.fileName).toBe("alpha.txt");
});
