import { describe, expect, test } from "bun:test";

import {
  errMsg,
  parseCli,
  printPeers,
  printResults,
  printShares,
  printStatus,
  runExecCommands,
} from "../../../src/cli_shared";
import type { CliNode } from "../../../src/types";

function makeNode(
  overrides: Partial<CliNode> = {},
): CliNode {
  return {
    getPeers: () => [],
    getResults: () => [],
    getShares: () => [],
    getStatus: () => ({
      peers: 0,
      shares: 0,
      results: 0,
      knownPeers: 0,
    }),
    ...overrides,
  };
}

describe("cli_shared", () => {
  test("formats errors and reports empty or populated status lists", () => {
    const logs: string[] = [];
    const node = makeNode({
      getPeers: () => [
        {
          key: "1.2.3.4:6346",
          remoteLabel: "1.2.3.4:6346",
          outbound: true,
        },
        {
          key: "5.6.7.8:6346",
          remoteLabel: "5.6.7.8:6346",
          outbound: false,
        },
      ],
      getShares: () => [
        { index: 1, size: 123, rel: 'folder/"song".mp3' },
      ],
      getStatus: () => ({
        peers: 2,
        shares: 1,
        results: 0,
        knownPeers: 9,
      }),
    });

    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg({ detail: 7 })).toBe("[object Object]");

    printStatus(node, (msg) => logs.push(msg));
    printPeers(makeNode(), (msg) => logs.push(msg));
    printPeers(node, (msg) => logs.push(msg));
    printShares(makeNode(), (msg) => logs.push(msg));
    printShares(node, (msg) => logs.push(msg));
    printResults(makeNode(), (msg) => logs.push(msg));

    expect(logs).toEqual([
      "peers=2 shares=1 results=0 knownPeers=9",
      "no peers",
      "1.2.3.4:6346 1.2.3.4:6346 outbound",
      "5.6.7.8:6346 5.6.7.8:6346 inbound",
      "no shared files",
      '#1 123B "folder/\\"song\\".mp3"',
      "no results",
    ]);
  });

  test("prints results as one aligned table without servent IDs", () => {
    const logs: string[] = [];
    const node = makeNode({
      getResults: () => [
        {
          resultNo: 12,
          remoteHost: "10.0.0.2",
          remotePort: 6346,
          fileSize: 1200,
          fileName: "zz-top.bin",
          serventIdHex: "aa".repeat(16),
        },
        {
          resultNo: 2,
          remoteHost: "9.8.7.6",
          remotePort: 1234,
          fileSize: 99,
          fileName: "alpha.txt",
          serventIdHex: "bb".repeat(16),
        },
        {
          resultNo: 7,
          remoteHost: "1.2.3.4",
          remotePort: 80,
          fileSize: 2048,
          fileName: "beta file.bin",
          serventIdHex: "cc".repeat(16),
        },
        {
          resultNo: 8,
          remoteHost: "8.8.8.8",
          remotePort: 6346,
          fileSize: 7777,
          fileName: "12345678901234567890123Xabcdefghijklmnopqrstuvw",
          serventIdHex: "dd".repeat(16),
        },
      ],
      getStatus: () => ({
        peers: 0,
        shares: 0,
        results: 4,
        knownPeers: 0,
      }),
    });

    printResults(node, (msg) => logs.push(msg));

    expect(logs).toEqual([
      [
        "No  File                                                Size  IP",
        "--  ------------------------------------------------  ------  --------",
        " 2  alpha.txt                                            99B  9.8.7.6",
        " 7  beta file.bin                                     2,048B  1.2.3.4",
        " 8  12345678901234567890123..abcdefghijklmnopqrstuvw  7,777B  8.8.8.8",
        "12  zz-top.bin                                        1,200B  10.0.0.2",
      ].join("\n"),
    ]);
  });

  test("parses CLI args with config overrides and queued exec commands", () => {
    expect(
      parseCli(
        [
          "init",
          "--config",
          "custom.json",
          "--exec",
          "query alpha",
          "ignored",
          "--exec",
        ],
        "gnutella.json",
      ),
    ).toEqual({
      command: "init",
      config: "custom.json",
      exec: ["query alpha", ""],
    });

    expect(parseCli(["--config"], "default.json")).toEqual({
      command: "run",
      config: "default.json",
      exec: [],
    });
  });

  test("runs exec commands after sleeping, logs failures, and stops on false", async () => {
    const logs: string[] = [];
    const sleeps: number[] = [];
    const commands: string[] = [];

    runExecCommands(
      ["explode", "stop", "skip"],
      (msg) => logs.push(msg),
      async (ms) => {
        sleeps.push(ms);
      },
      async (line) => {
        commands.push(line);
        if (line === "explode") throw new Error("boom");
        return line !== "stop";
      },
      errMsg,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sleeps).toEqual([500]);
    expect(commands).toEqual(["explode", "stop"]);
    expect(logs).toEqual([
      "exec> explode",
      "command failed: boom",
      "exec> stop",
    ]);
  });

  test("skips exec scheduling when no commands are provided", () => {
    let slept = false;
    let ran = false;

    runExecCommands(
      [],
      () => {
        throw new Error("unexpected log");
      },
      async () => {
        slept = true;
      },
      async () => {
        ran = true;
        return true;
      },
      errMsg,
    );

    expect(slept).toBe(false);
    expect(ran).toBe(false);
  });
});
