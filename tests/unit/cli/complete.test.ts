import { expect, test } from "bun:test";
import {
  complete,
  completionContext,
  readlineCompletion,
  type CompletionContext,
} from "../../../src/cli/complete";
import { parseCommand } from "../../../src/cli/parse";
import { makeNode, withTempDir } from "../../helpers/protocol";
import { seedSearch } from "../../helpers/search";

const context: CompletionContext = {
  targets: [
    ...[1, 3, 4, 7, 12].map((number) => ({
      domain: "results" as const,
      number,
      id: String(number),
    })),
    ...[1, 2, 9, 10, 20, 21].map((number) => ({
      domain: "downloads" as const,
      number,
      id: `d${number}`,
      status: "queued",
    })),
    ...[1, 2, 10].map((number) => ({
      domain: "searches" as const,
      number,
      id: String(number),
      status: "active",
    })),
  ],
  peers: ["p2", "p1", "p10"],
  blocked: ["127.0.0.2"],
};
function candidates(line: string) {
  return complete(line, line.length, context).candidates;
}
test("commands, aliases, modes, domain vocabulary and numeric ordering", () => {
  expect(candidates("se")).toEqual(["search"]);
  expect(candidates("ex")).toEqual(["exit"]);
  expect(candidates("")).toContain("download");
  expect(candidates("monitor ")).toEqual([
    "all",
    "downloads",
    "off",
    "on",
  ]);
  expect(candidates("browse ")).toEqual(["p1", "p2", "p10"]);
  expect(candidates("unblock ")).toEqual(["127.0.0.2"]);
  expect(candidates("clear ")).toContain("searches");
  expect(candidates("clear ")).toContain("downloads");
  expect(candidates("clear ")).not.toContain("all");
  expect(candidates("clear searches ")).toEqual([
    "active",
    "all",
    "complete",
    "failed",
    "q1",
    "q2",
    "q10",
  ]);
  expect(candidates("remove d")).toEqual([
    "d1",
    "d2",
    "d9",
    "d10",
    "d20",
    "d21",
  ]);
  expect(candidates("download ")).toEqual(["1", "3", "4", "7", "12"]);
});
test("member and endpoint replacement, homogeneous lists, no side effects", () => {
  expect(candidates("download 3-7,")).toEqual(["1", "12"]);
  expect(candidates("remove d1-d9007199254740991,")).not.toContain("d20");
  expect(candidates("download 3,")).toEqual(["1", "4", "7", "12"]);
  expect(candidates("download 3,  ")).toEqual(["1", "4", "7", "12"]);
  expect(candidates("remove d10-d2")).toEqual(["d20", "d21"]);
  expect(candidates("remove d10 - ")).toEqual(["d10", "d20", "d21"]);
  expect(candidates("clear q1,")).toEqual([
    "active",
    "complete",
    "failed",
    "q2",
    "q10",
  ]);
  expect(candidates("info 1,")).toEqual(["3", "4", "7", "12"]);
  expect(candidates("info d1,")).not.toContain("1");
  expect(candidates("query active,")).toEqual([]);
  expect(candidates("download 3 ")).toEqual([]);
  expect(candidates('download 3 "my path')).toEqual([]);
  expect(candidates("remove zz")).toEqual([]);
  expect(candidates("help ")).toEqual([]);
  expect(candidates("monitor on ")).toEqual([]);
  expect(candidates("remove verification_")).toEqual([
    "verification_failed",
  ]);
});
test("quoted input and replacement spans preserve surrounding text", () => {
  expect(candidates('remove "d1')).toEqual(["d1", "d10"]);
  expect(candidates('remove "d1"')).toEqual(['d1"', 'd10"']);
  expect(candidates('remove "d1, d2')).toEqual(["d2", "d20", "d21"]);
  const line = 'download 3,1 "music/Live recording.flac"';
  const cursor = line.indexOf(' "');
  const result = complete(line, cursor, context);
  expect(result.span).toEqual({ start: 11, end: 12 });
  expect(result.candidates).toEqual(["1", "12"]);
  expect(
    line.slice(0, result.span.start) + "12" + line.slice(cursor),
  ).toBe('download 3,12 "music/Live recording.flac"');
  expect(readlineCompletion(line.slice(0, cursor), line, context)).toEqual(
    [["1", "12"], "1"],
  );
  const middle = "remove d0,failed";
  const edit = complete(middle, 8, context);
  expect(edit.candidates).toEqual(["d1", "d2"]);
  expect(
    middle.slice(0, edit.span.start) +
      edit.candidates[1] +
      middle.slice(8),
  ).toBe("remove d20,failed");
});
test("offered values parse when the rest of the command is complete", () => {
  for (const line of [
    "download ",
    "remove ",
    "results ",
    "info ",
    "magnet ",
    "clear downloads ",
    "clear searches ",
    "pause active,",
    "download 1,",
    "remove d10-d2",
    'remove "d1"',
    "monitor ",
  ]) {
    const result = complete(line, line.length, context);
    for (const candidate of result.candidates)
      expect(
        parseCommand(line.slice(0, result.span.start) + candidate).ok,
      ).toBe(true);
  }
});
test("read-only context refreshes handles without owner actions", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(`${dir}/config.json`);
    seedSearch(node, []);
    expect(
      complete("results q", 9, completionContext(node)).candidates,
    ).toEqual(["q1"]);
    node.clearResults();
    expect(
      complete("results q", 9, completionContext(node)).candidates,
    ).toEqual([]);
    seedSearch(node, []);
    expect(
      complete("results q", 9, completionContext(node)).candidates,
    ).toEqual(["q2"]);
    expect(node.getSearches()).toHaveLength(1);
    expect(node.getDownloadJobs()).toEqual([]);
  });
});

test("empty closed quotes and exact explicit domains keep their delimiters", () => {
  for (const line of ['monitor ""', 'remove ""', 'remove "d1, "']) {
    const result = complete(line, line.length, context);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const value of result.candidates)
      expect(
        parseCommand(line.slice(0, result.span.start) + value).ok,
      ).toBe(true);
  }
  expect(candidates("clear searches")).toEqual(["searches"]);
  expect(candidates("clear downloads")).toEqual(["downloads"]);
});
