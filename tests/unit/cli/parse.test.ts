import { describe, expect, test } from "bun:test";
import { commandHelp, COMMANDS } from "../../../src/cli/commands";
import { parseCommand } from "../../../src/cli/parse";
import { scan } from "../../../src/cli/tokens";

function parsed(line: string) {
  const result = parseCommand(line);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostic));
  return result.command;
}
describe("strict scanner and command language", () => {
  test("decoded values, raw spans, empty tokens, quotes and escapes", () => {
    const line = `download 3 "Music/live recording,part-1.flac"`;
    const tokens = scan(line);
    expect(tokens.map((t) => t.value)).toEqual([
      "download",
      "3",
      "Music/live recording,part-1.flac",
    ]);
    expect(line.slice(tokens[2].start, tokens[2].end)).toBe(
      '"Music/live recording,part-1.flac"',
    );
    expect(
      scan(`query "" 'two  words' plain\\ space`).map((t) => t.value),
    ).toEqual(["query", "", "two  words", "plain space"]);
    expect(parsed(line)).toMatchObject({
      name: "download",
      destination: "Music/live recording,part-1.flac",
    });
    expect(parsed("download 3 Music/live\\ recording.flac")).toMatchObject(
      { destination: "Music/live recording.flac" },
    );
  });
  test("aliases, case, text and defaults", () => {
    expect(parsed("SeArCh Active,queued A-B")).toEqual({
      name: "query",
      text: "Active,queued A-B",
    });
    expect(parsed("ExIt")).toEqual({ name: "quit" });
    expect(parsed("MONITOR ON")).toEqual({ name: "monitor", mode: "on" });
    expect(parsed("ping")).toEqual({ name: "ping" });
    expect(parsed("sleep")).toEqual({ name: "sleep", seconds: 0 });
    expect(parsed("sleep .125")).toEqual({
      name: "sleep",
      seconds: 0.125,
    });
    expect(parsed("download 3 4")).toMatchObject({
      name: "download",
      destination: "4",
    });
    expect(parsed('download "3, 4 - 7"')).toMatchObject({
      selector: {
        items: [
          { kind: "reference", number: 3 },
          { kind: "range", first: 4, last: 7 },
        ],
      },
    });
  });
  test("strict submissions reject incomplete editing while tolerant scanning retains state", () => {
    for (const line of ['query "abc', "query 'abc", "query abc\\"]) {
      expect(parseCommand(line).ok).toBe(false);
      expect(scan(line, true)).toHaveLength(2);
    }
    expect(scan('query "abc', true)[1].quote).toBe('"');
    expect(scan("query abc\\", true)[1].escaped).toBe(true);
  });
  test("all definitions supply help and aliases", () => {
    const help = commandHelp();
    for (const definition of COMMANDS) {
      expect(help).toContain(definition.usage);
      for (const alias of definition.aliases)
        expect(help).toContain(alias);
    }
    expect(help).toContain("incomplete files");
    expect(help).toContain("Missing explicit IDs");
  });
  test("diagnostics point to offending raw input", () => {
    const line = "remove d1,  actve";
    const result = parseCommand(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      line.slice(result.diagnostic.span.start, result.diagnostic.span.end),
    ).toBe("actve");
    expect(result.diagnostic.suggestion).toBe("active");
    expect(result.diagnostic.usage).toBe("remove <selector>");
  });
});
for (const line of [
  "help extra",
  "status extra",
  "peers extra",
  "shares extra",
  "queries extra",
  "save extra",
  "rescan extra",
  "quit extra",
  "blocked extra",
  "block",
  "unblock a b",
  "connect a b",
  "browse a b",
  "query",
  'query ""',
  "monitor bogus",
  "monitor on extra",
  "ping 0",
  "ping -1",
  "ping 256",
  "ping 1.2",
  "ping 1e2",
  "ping 01",
  "ping 1 2",
  "sleep -1",
  "sleep NaN",
  "sleep Infinity",
  "sleep 1e2",
  "sleep 2147484",
  "sleep 1 2",
  "download",
  "download 3 a b",
  'download 3 ""',
  "download all",
  "download active",
  "download 0",
  "download 01",
  "download +1",
  "download -1",
  "download 1.0",
  "download 1e2",
  "download 9007199254740992",
  "download 3-7backup",
  "download 7-3",
  "download 1-",
  "download -3",
  "download 1,,2",
  "download 1,",
  "remove d10-20",
  "remove d10-q20",
  "remove d0",
  "remove d01",
  "remove d1,2",
  "remove d2 d3",
  "remove active|queued",
  "clear all",
  "clear all,d1",
  "clear q1,d1",
  "clear downloads",
  "clear searches",
  "clear searches d1",
  "info all",
  "info q1",
  "info d1,2",
  "magnet d1",
  "results d1",
  `results ${"ab".repeat(16)}-${"cd".repeat(16)}`,
])
  test(`rejects ${line}`, () => expect(parseCommand(line).ok).toBe(false));
for (const line of [
  "download 3,4,7",
  "download 3-7,12",
  "download 3, 4, 7",
  "remove d10 - d20",
  "pause active,queued",
  "resume failed,verification_failed",
  "clear complete",
  "clear searches q1-q3,q7",
  "downloads active,queued",
  "clear downloads all",
  "clear searches active",
  "results all",
  "results q1,active",
  `results q1,${"ab".repeat(16)}`,
  "info active,d1",
  "magnet 1-9007199254740991",
  "ping 255",
])
  test(`accepts ${line}`, () => expect(parseCommand(line).ok).toBe(true));
