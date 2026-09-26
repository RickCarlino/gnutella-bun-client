import { expect, test } from "bun:test";
import { executeSelection, type BatchNode } from "../../../src/cli/batch";
import { parseCommand } from "../../../src/cli/parse";
import type { DownloadJob } from "../../../src/downloads";
import type { SearchSession } from "../../../src/search/types";
import type { SearchHit } from "../../../src/types";

function job(
  id: string,
  status: DownloadJob["status"] = "active",
): DownloadJob {
  return {
    id,
    status,
    fileName: `${id}.txt`,
    fileSize: 10,
    urns: [],
    destPath: `/test/${id}`,
    incompletePath: `/test/${id}.part`,
    bytesCompleted: 0,
    createdAt: "",
    updatedAt: "",
    sources: [],
  };
}
function fixture() {
  const jobs = [job("d1"), job("d2"), job("d3", "complete")];
  const searches: SearchSession[] = [
    {
      id: "ab".repeat(16),
      number: 1,
      kind: "query",
      search: "fixture",
      createdAt: 0,
      status: "active",
      resultCount: 3,
    },
  ];
  const results: SearchHit[] = [1, 2, 3].map((resultNo) => ({
    resultNo,
    queryIdHex: searches[0].id,
    queryHops: 1,
    remoteHost: "127.0.0.1",
    remotePort: 6346,
    speedKBps: 1,
    fileIndex: resultNo,
    fileName: `${resultNo}.txt`,
    fileSize: 10,
    serventIdHex: "cd".repeat(16),
    viaPeerKey: "p1",
  }));
  const calls: string[] = [];
  const logs: string[] = [];
  let beforePause = async (_id: string) => {};
  const findJob = (id: string) => {
    const found = jobs.find((j) => j.id === id);
    if (!found) throw new Error("gone");
    return found;
  };
  const node: BatchNode = {
    getDownloadJobs: () => structuredClone(jobs),
    getSearches: () => structuredClone(searches),
    getResults: () => structuredClone(results),
    getResult: (number) => {
      const hit = results.find((r) => r.resultNo === number);
      if (!hit) throw new Error("missing result");
      return hit;
    },
    pauseDownload: async (id) => {
      calls.push(`pause ${id}`);
      await beforePause(id);
      const j = findJob(id);
      if (j.status !== "complete") j.status = "paused";
      return { ...j };
    },
    resumeDownload: async (id) => {
      calls.push(`resume ${id}`);
      const j = findJob(id);
      if (j.status !== "complete") j.status = "queued";
      return { ...j };
    },
    removeDownload: async (id) => {
      calls.push(`remove ${id}`);
      jobs.splice(jobs.indexOf(findJob(id)), 1);
    },
    clearResults: (id) => {
      calls.push(`clear ${id}`);
      const index = searches.findIndex((s) => s.id === id);
      searches.splice(index, 1);
    },
    downloadResult: async (number, destination) => {
      calls.push(`download ${number} ${destination ?? ""}`);
      if (!jobs.some((j) => j.id === "d4")) jobs.push(job("d4", "queued"));
      return findJob("d4");
    },
  };
  const run = async (line: string) => {
    const parsed = parseCommand(line);
    if (!parsed.ok) throw new Error(parsed.diagnostic.message);
    if (!parsed.command || !("selector" in parsed.command))
      throw new Error("expected selection");
    return executeSelection(parsed.command, node, (line) =>
      logs.push(line),
    );
  };
  return {
    jobs,
    searches,
    results,
    calls,
    logs,
    run,
    onPause: (callback: typeof beforePause) => {
      beforePause = callback;
    },
  };
}
test("preflight rejects every invalid target/cardinality before any action", async () => {
  const f = fixture();
  for (const line of [
    "pause d1,d999",
    "download 1,999",
    "download 1-3 one-file",
    "pause d1,actve",
    "clear q1,d1",
  ])
    await expect(f.run(line)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(f.jobs[0].status).toBe("active");
});
test("membership frozen once despite new jobs and status changes; sequential failures continue", async () => {
  const f = fixture();
  f.onPause(async (id) => {
    if (id === "d1") {
      f.jobs.push(job("d4"));
      f.jobs[1].status = "failed";
      await Promise.resolve();
      throw new Error("disk failure");
    }
    expect(f.calls).toEqual(["pause d1", "pause d2"]);
  });
  const outcome = await f.run("pause active");
  expect(f.calls).toEqual(["pause d1", "pause d2"]);
  expect(outcome).toMatchObject({ successes: 1, failures: 1 });
  expect(outcome.targets[0]).toEqual({
    target: "d1",
    status: "failure",
    reason: "disk failure",
  });
  expect(f.jobs[3].status).toBe("active");
  expect(f.logs.join("\n")).toContain("d1 failed: disk failure");
});
test("owner existence is rechecked for disappearing targets", async () => {
  const f = fixture();
  f.onPause(async (id) => {
    if (id === "d1") f.jobs.splice(1, 1);
  });
  const outcome = await f.run("pause d1-d3");
  expect(f.calls).toEqual(["pause d1", "pause d3"]);
  expect(outcome).toMatchObject({ successes: 1, noops: 1, failures: 1 });
  expect(outcome.targets[1].reason).toBe("no such download d2");
});
test("owner no-ops are counted and duplicates execute once", async () => {
  const f = fixture();
  const outcome = await f.run("pause d3,d1-d3,active");
  expect(f.calls).toEqual(["pause d3", "pause d1", "pause d2"]);
  expect(outcome).toMatchObject({ successes: 2, noops: 1, failures: 0 });
  expect((await f.run("resume complete")).noops).toBe(1);
});
test("range gaps and empty keywords are successful no-ops", async () => {
  const f = fixture();
  expect(
    (await f.run("remove d4-d9007199254740991,failed")).failures,
  ).toBe(0);
  expect(f.calls).toEqual([]);
  expect(f.logs).toEqual(["no matching downloads; no actions taken"]);
});
test("destinations require one unique result; input results and created jobs have separate totals", async () => {
  const f = fixture();
  const first = await f.run('download 1,1-1 "Music/live recording.flac"');
  expect(f.calls).toEqual(["download 1 Music/live recording.flac"]);
  expect(first.createdJobs).toEqual(["d4"]);
  const second = await f.run("download 1-3");
  expect(second.successes).toBe(3);
  expect(second.createdJobs).toEqual([]);
  expect(f.logs.at(-1)).toContain("3 input results, 0 created jobs");
});
test("clear download forms and remove delegate identically; bare clear touches searches only", async () => {
  const a = fixture();
  const b = fixture();
  await a.run("clear d1");
  await b.run("remove d1");
  expect(a.calls).toEqual(b.calls);
  await a.run("clear");
  expect(a.jobs).toHaveLength(2);
  expect(a.searches).toEqual([]);
});

test("resume of queued jobs is an action even when the returned status is unchanged", async () => {
  const f = fixture();
  f.jobs[0].status = "queued";
  expect(await f.run("resume d1")).toMatchObject({
    successes: 1,
    noops: 0,
  });
  expect(f.calls).toEqual(["resume d1"]);
});

test("download listings preserve resolved union order", async () => {
  const f = fixture();
  const outcome = await f.run("downloads d3,d1-d2,d3");
  expect(outcome.targets.map((t) => t.target)).toEqual(["d3", "d1", "d2"]);
  const table = f.logs[0];
  expect(table.indexOf("d3")).toBeLessThan(table.indexOf("d1"));
  expect(table.indexOf("d1")).toBeLessThan(table.indexOf("d2"));
});
