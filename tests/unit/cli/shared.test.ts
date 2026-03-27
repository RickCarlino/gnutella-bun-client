import { describe, expect, test } from "bun:test";

import { printResults } from "../../../src/cli_shared";
import type { CliNode } from "../../../src/types";

describe("cli_shared", () => {
  test("prints results as one aligned table without servent IDs", () => {
    const logs: string[] = [];
    const node: CliNode = {
      getPeers: () => [],
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
      getShares: () => [],
      getStatus: () => ({
        peers: 0,
        shares: 0,
        results: 4,
        knownPeers: 0,
      }),
    };

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
});
