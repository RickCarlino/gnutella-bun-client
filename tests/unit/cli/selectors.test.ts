import { expect, test } from "bun:test";
import { parseCommand } from "../../../src/cli/parse";
import { resolveSelector, type Target } from "../../../src/cli/resolve";
import type { Selector } from "../../../src/cli/selectors";

function selector(line: string): Selector {
  const parsed = parseCommand(line);
  if (!parsed.ok || !parsed.command || !("selector" in parsed.command))
    throw new Error("invalid test selector");
  return parsed.command.selector;
}
const jobs: Target[] = [
  { domain: "downloads", id: "d10", number: 10, status: "failed" },
  { domain: "downloads", id: "d9", number: 9, status: "active" },
  {
    domain: "downloads",
    id: "d12",
    number: 12,
    status: "verification_failed",
  },
  { domain: "downloads", id: "d3", number: 3, status: "verifying" },
  { domain: "downloads", id: "d20", number: 20, status: "failed" },
];
function ids(line: string, snapshot = jobs) {
  return resolveSelector(selector(line), snapshot).map((t) => t.id);
}
test("numeric expansion, union order and canonical deduplication", () => {
  expect(ids("remove d20,d9-d12,failed,all")).toEqual([
    "d20",
    "d9",
    "d10",
    "d12",
    "d3",
  ]);
  expect(ids("pause all")).toEqual(["d3", "d9", "d10", "d12", "d20"]);
  expect(ids("remove D10,d10,failed")).toEqual(["d10", "d20"]);
});
test("exact statuses and empty range/keyword union", () => {
  expect(ids("remove failed")).toEqual(["d10", "d20"]);
  expect(ids("pause active")).toEqual(["d9"]);
  expect(ids("remove d4-d8,queued")).toEqual([]);
  expect(() => ids("remove d9,d11")).toThrow("no such download d11");
});
test("sparse enormous ranges do not allocate by range size", () => {
  expect(ids("remove d1-d9007199254740991")).toEqual([
    "d3",
    "d9",
    "d10",
    "d12",
    "d20",
  ]);
});
test("full search IDs match exactly and deduplicate against handles", () => {
  const searches: Target[] = [
    {
      domain: "searches",
      id: "ab".repeat(16),
      number: 2,
      status: "active",
    },
    {
      domain: "searches",
      id: "cd".repeat(16),
      number: 10,
      status: "complete",
    },
  ];
  expect(ids(`results ${"ab".repeat(16)},q2-q10,all`, searches)).toEqual(
    searches.map((t) => t.id),
  );
  expect(() => ids(`results ${"AB".repeat(16)}`, searches)).toThrow(
    "no such search",
  );
});
test("clear domain inference is entirely syntactic", () => {
  expect(selector("clear").domain).toBe("searches");
  expect(selector("clear q1-q3").domain).toBe("searches");
  expect(selector(`clear ${"d1".repeat(16)}`).domain).toBe("searches");
  for (const status of ["active", "queued", "failed", "complete"])
    expect(selector(`clear ${status}`).domain).toBe("downloads");
  expect(selector("clear searches active").domain).toBe("searches");
});
