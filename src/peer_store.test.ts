import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PeerStore } from "./peer_store";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("PeerStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "peerstore-"));
    file = join(dir, "peers.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("add, save and load peers", async () => {
    const store = new PeerStore(file);
    store.add("1.2.3.4", 1234, 1);
    await store.save();
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(data.peers.length).toBe(1);

    const store2 = new PeerStore(file);
    await store2.load();
    expect(store2.get(1)[0].ip).toBe("1.2.3.4");
  });

  test("prunes old peers", () => {
    const store = new PeerStore(file);
    const old = Date.now() - 10000;
    store.add("1.2.3.4", 1234, old);
    store.prune(1000);
    expect(store.get(1).length).toBe(0);
  });
});
