import { describe, test, expect } from "bun:test";
import { QRPManager } from "./qrp_manager";
import { MessageParser } from "./message_parser";

describe("QRPManager", () => {
  test("add/remove and query", () => {
    const qrp = new QRPManager(32, 7);
    const idx = qrp.addFile("music.mp3", 123, ["music", "mp3"]);
    expect(qrp.getFiles().length).toBe(1);
    expect(qrp.matchesQuery("music")).toBe(true);
    expect(qrp.getMatchingFiles("music")[0].index).toBe(idx);
    expect(qrp.removeFile(idx)).toBe(true);
    expect(qrp.getFiles().length).toBe(0);
  });

  test("build reset message", () => {
    const qrp = new QRPManager(32, 7);
    const buf = qrp.buildResetMessage();
    const parsed =
      MessageParser.parse(buf) as import("./core_types").RouteTableUpdateMessage;
    expect(parsed.type).toBe("route_table_update");
    expect(parsed.variant).toBe("reset");
  });

  test("build patch message", async () => {
    const qrp = new QRPManager(32, 7);
    qrp.addFile("a.txt", 1, ["a"]);
    const msgs = await qrp.buildPatchMessage();
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      const parsed =
        MessageParser.parse(m) as import("./core_types").RouteTableUpdateMessage;
      expect(parsed.type).toBe("route_table_update");
      expect(parsed.variant).toBe("patch");
    }
  });
});
