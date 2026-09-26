import { describe, expect, test } from "bun:test";
import { monitorAllowsEvent } from "../../../src/cli_monitor";
import type { GnutellaEvent } from "../../../src/types";
import { executeLine, executionContext } from "../../helpers/cli";
import { makeNode, withTempDir } from "../../helpers/protocol";

const handshake: GnutellaEvent = {
  type: "HANDSHAKE_DEBUG",
  at: "now",
  direction: "outbound",
  phase: "failed",
  peer: "127.0.0.1:6346",
  message: "connect timeout",
};
const download: GnutellaEvent = {
  type: "DOWNLOAD_DIRECT_FAILED",
  at: "now",
  resultNo: 22,
  fileName: "test.iso",
  destPath: "/tmp/test.part",
  remoteHost: "127.0.0.1",
  remotePort: 6346,
  message: "download body stalled",
};

describe("monitor modes", () => {
  test("switches immediately and keeps explicit modes idempotent", async () => {
    await withTempDir(async (dir) => {
      const context = executionContext(makeNode(`${dir}/config.json`));
      for (const [line, mode] of [
        ["monitor downloads", "downloads"],
        ["monitor downloads", "downloads"],
        ["monitor on", "all"],
        ["monitor all", "all"],
        ["monitor off", "off"],
        ["monitor", "all"],
        ["monitor", "off"],
        ["monitor downloads", "downloads"],
        ["monitor", "off"],
      ] as const) {
        await executeLine(context, line);
        expect(context.monitor.get()).toBe(mode);
      }
      await expect(
        executeLine(context, "monitor unknown"),
      ).rejects.toThrow("usage: monitor");
      await expect(
        executeLine(context, "monitor downloads extra"),
      ).rejects.toThrow("usage: monitor");
    });
  });

  test("download mode excludes handshake warnings while retaining transfer failures", () => {
    expect(monitorAllowsEvent("downloads", handshake)).toBe(false);
    expect(monitorAllowsEvent("downloads", download)).toBe(true);
    expect(monitorAllowsEvent("all", handshake)).toBe(true);
    expect(monitorAllowsEvent("off", download)).toBe(false);
  });

  test("download mode retains job lifecycle and download-manager errors", () => {
    expect(
      monitorAllowsEvent("downloads", {
        type: "DOWNLOAD_PAUSED",
        at: "now",
        jobId: "d5",
        fileName: "test.iso",
      }),
    ).toBe(true);
    expect(
      monitorAllowsEvent("downloads", {
        type: "MAINTENANCE_ERROR",
        at: "now",
        operation: "DOWNLOAD_MANAGER",
        message: "cannot save download state",
      }),
    ).toBe(true);
    expect(
      monitorAllowsEvent("downloads", {
        type: "MAINTENANCE_ERROR",
        at: "now",
        operation: "RECONNECT",
        message: "cannot connect",
      }),
    ).toBe(false);
  });
});
