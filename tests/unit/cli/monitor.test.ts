import { describe, expect, test } from "bun:test";

import {
  monitorAllowsEvent,
  selectMonitorMode,
} from "../../../src/cli_monitor";
import type { GnutellaEvent } from "../../../src/types";

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
  test("switches immediately and keeps explicit modes idempotent", () => {
    expect(selectMonitorMode(["downloads"], "off")).toBe("downloads");
    expect(selectMonitorMode(["downloads"], "downloads")).toBe(
      "downloads",
    );
    expect(selectMonitorMode(["on"], "downloads")).toBe("all");
    expect(selectMonitorMode(["all"], "downloads")).toBe("all");
    expect(selectMonitorMode(["off"], "downloads")).toBe("off");
    expect(selectMonitorMode([], "off")).toBe("all");
    expect(selectMonitorMode([], "downloads")).toBe("off");
    expect(selectMonitorMode([], "all")).toBe("off");
    expect(() => selectMonitorMode(["unknown"], "downloads")).toThrow(
      "usage: monitor",
    );
    expect(() => selectMonitorMode(["downloads", "extra"], "off")).toThrow(
      "usage: monitor",
    );
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
