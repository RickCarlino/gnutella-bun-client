import { expect, test } from "bun:test";
import { encodeQueryHit, parseQueryHit } from "../../../src/wire/codec";
import { executeLine, executionContext } from "../../helpers/cli";
import {
  makeNode,
  makePeer,
  makeShare,
  withTempDir,
} from "../../helpers/protocol";
import { seedSearch } from "../../helpers/search";

function deliver(
  node: ReturnType<typeof makeNode>,
  id: string,
  name: string,
) {
  node.search.ingest(
    { queryIdHex: id, queryHops: 1, viaPeerKey: "p1" },
    parseQueryHit(
      encodeQueryHit(
        6346,
        "127.0.0.1",
        512,
        [makeShare(1, `/synthetic/${name}`, name)],
        Buffer.alloc(16, 2),
      ),
    ),
  );
}

test("results groups all queries under headings and an ID filters without changing state", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`);
    node.connections.peers.set("p1", makePeer("p1"));
    const logs: string[] = [];
    const run = async (command: string, ...args: string[]) => {
      logs.length = 0;
      await executeLine(
        executionContext(node, (line) => logs.push(line)),
        [command, ...args].join(" "),
      );
      return logs.join("\n");
    };
    expect(await run("query", "alpha")).toBe('q1: "alpha"');
    expect(await run("query", "beta")).toBe('q2: "beta"');
    const [a, b] = node.getSearches();
    deliver(node, b!.id, "beta.txt");
    deliver(node, a!.id, "alpha.txt");
    const queries = await run("queries");
    expect(logs).toEqual([queries]);
    expect(
      queries
        .split("\n")
        .slice(2)
        .map((line) => line.split(/ {2,}/)),
    ).toEqual([
      ["q1", "1", "alpha"],
      ["q2", "1", "beta"],
    ]);
    const grouped = await run("results");
    expect(logs).toEqual([grouped]);
    const sections = grouped.split("q2:");
    expect(sections[0]).toContain('q1: "alpha"');
    expect(sections[0]).toContain("alpha.txt");
    expect(sections[0]).not.toContain("beta.txt");
    expect(sections[1]).toContain('"beta"');
    expect(sections[1]).toContain("beta.txt");
    expect(sections[1]).not.toContain("alpha.txt");
    const filtered = await run("results", "q2");
    expect(logs).toEqual([filtered]);
    expect(filtered).toContain("beta.txt");
    expect(filtered).not.toContain("alpha.txt");
    expect(filtered).not.toContain("q1:");
    expect(await run("results")).toBe(grouped);
    expect(await run("results", a!.id)).toContain("alpha.txt");
    // Result lookup is independent of which listing was most recently printed.
    expect(node.getResult(1).fileName).toBe("beta.txt");
    expect(node.getResult(2).fileName).toBe("alpha.txt");
    expect(await run("clear", "q1")).toBe("");
    expect(() => node.getResults(a!.id)).toThrow("no such search");
    expect(node.getResults(b!.id)).toHaveLength(1);
    deliver(node, a!.id, "late-alpha.txt");
    expect(await run("results")).not.toContain("q1:");
    expect(await run("results")).toContain("beta.txt");
    await expect(run("results", "q1")).rejects.toThrow(
      "no such search q1",
    );
    expect(await run("clear", "q2")).toBe("");
    expect(await run("results")).toBe("no searches");
  });
});

test("query summaries retain empty searches and reject invalid filters", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`);
    const a = seedSearch(node, []);
    seedSearch(node, []);
    const logs: string[] = [];
    await executeLine(
      executionContext(node, (line) => logs.push(line)),
      "queries",
    );
    expect(logs).toHaveLength(1);
    expect(
      logs[0]!.split("\n").map((line) => line.split(/ {2,}/)),
    ).toEqual([
      ["Query", "Results", "Search term"],
      ["-----", "-------", "-----------"],
      ["q1", "0", "fixture"],
      ["q2", "0", "fixture"],
    ]);
    logs.length = 0;
    await executeLine(
      executionContext(node, (text) => logs.push(text)),
      "results",
    );
    expect(logs).toEqual([
      'q1: "fixture"\nno results\n\nq2: "fixture"\nno results\nresults: 2 succeeded, 0 no-op, 0 failed',
    ]);
    await expect(
      executeLine(executionContext(node), "results q1 q2"),
    ).rejects.toThrow("usage: results [selector]");
    await expect(
      executeLine(executionContext(node), "results q999"),
    ).rejects.toThrow("no such search");
    expect(node.getSearches()[0]!.id).toBe(a.id);
    expect(node.getSearches()).toHaveLength(2);
  });
});

test("offline and invalid queries leave existing sessions alone", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`);
    const a = seedSearch(node, []);
    const logs: string[] = [];
    await executeLine(
      executionContext(node, (line) => logs.push(line)),
      "query offline",
    );
    expect(logs).toEqual(["no peers connected"]);
    await expect(
      executeLine(executionContext(node), "query"),
    ).rejects.toThrow("usage:");
    expect(node.getSearches().map((search) => search.id)).toEqual([a.id]);
  });
});

test("clear without an ID removes all searches and ignores their late replies", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`);
    const a = seedSearch(node, []);
    const b = seedSearch(node, []);
    deliver(node, a.id, "alpha.txt");
    deliver(node, b.id, "beta.txt");
    const logs: string[] = [];
    await executeLine(
      executionContext(node, (line) => logs.push(line)),
      "clear",
    );
    expect(logs).toEqual(["clear: 2 succeeded, 0 no-op, 0 failed"]);
    expect(node.getSearches()).toEqual([]);
    expect(() => node.getResult(1)).toThrow("no such result");
    deliver(node, a.id, "late-alpha.txt");
    deliver(node, b.id, "late-beta.txt");
    expect(node.getStatus().results).toBe(0);
    const next = seedSearch(node, []);
    deliver(node, next.id, "new.txt");
    expect(node.getResult(3).fileName).toBe("new.txt");
    await expect(
      executeLine(executionContext(node), "clear q999"),
    ).rejects.toThrow("no such search");
    expect(node.getStatus().results).toBe(1);
  });
});
