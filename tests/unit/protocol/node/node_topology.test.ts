import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  makeNode,
  makePeer,
  overrideRuntimeConfig,
  withTempDir,
} from "./helpers";

describe("protocol node topology", () => {
  test("classifies peers and reports role counts", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const leafPeer = makePeer("1.1.1.1:1111");
      const ultrapeerPeer = makePeer("2.2.2.2:2222");
      ultrapeerPeer.role = "ultrapeer";
      ultrapeerPeer.capabilities.isUltrapeer = true;

      node.peers.set(leafPeer.key, leafPeer);
      node.peers.set(ultrapeerPeer.key, ultrapeerPeer);

      expect(node.nodeMode()).toBe("leaf");
      expect(
        node.classifyPeerRole({
          ...leafPeer.capabilities,
          isUltrapeer: false,
        }),
      ).toBe("leaf");

      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
      });

      expect(node.nodeMode()).toBe("ultrapeer");
      expect(
        node.classifyPeerRole({
          ...leafPeer.capabilities,
          isUltrapeer: true,
        }),
      ).toBe("ultrapeer");
      expect(node.peerRole(leafPeer)).toBe("leaf");
      expect(node.countPeersByRole("leaf")).toBe(1);
      expect(node.countPeersByRole("ultrapeer")).toBe(1);
      expect(node.connectedLeafCount()).toBe(1);
      expect(node.connectedMeshPeerCount()).toBe(1);
      expect(node.isLeafPeer(leafPeer)).toBe(true);
      expect(node.isLeafPeer(ultrapeerPeer)).toBe(false);
      expect(node.isMeshPeer(leafPeer)).toBe(false);
      expect(node.isMeshPeer(ultrapeerPeer)).toBe(true);
    });
  });

  test("enforces shielded leaf admission rules and slot counts", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, { maxUltrapeerConnections: 2 });

      const ultrapeerOne = makePeer("3.3.3.3:3333");
      ultrapeerOne.role = "ultrapeer";
      ultrapeerOne.capabilities.isUltrapeer = true;
      node.peers.set(ultrapeerOne.key, ultrapeerOne);
      node.dialing.add("4.4.4.4:4444");

      expect(node.availableDialSlots()).toBe(0);
      expect(node.shouldRelayQueries()).toBe(false);
      expect(node.shouldRelayPings()).toBe(false);
      expect(node.canAcceptPeerRole("leaf")).toEqual({
        ok: false,
        code: 503,
        reason: "Shielded leaf node (2 ultrapeers max)",
      });
      expect(node.canAcceptPeerRole("ultrapeer")).toEqual({ ok: true });

      const ultrapeerTwo = makePeer("5.5.5.5:5555");
      ultrapeerTwo.role = "ultrapeer";
      ultrapeerTwo.capabilities.isUltrapeer = true;
      node.peers.set(ultrapeerTwo.key, ultrapeerTwo);

      expect(node.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: false,
        code: 503,
        reason: "Too many ultrapeer connections (2 max)",
      });
    });
  });

  test("enforces ultrapeer admission rules and slot counts", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        maxConnections: 2,
        maxLeafConnections: 1,
      });

      const leafPeer = makePeer("6.6.6.6:6666");
      const ultrapeerOne = makePeer("7.7.7.7:7777");
      ultrapeerOne.role = "ultrapeer";
      ultrapeerOne.capabilities.isUltrapeer = true;
      node.peers.set(leafPeer.key, leafPeer);
      node.peers.set(ultrapeerOne.key, ultrapeerOne);
      node.dialing.add("8.8.8.8:8888");

      expect(node.availableDialSlots()).toBe(0);
      expect(node.shouldRelayQueries()).toBe(true);
      expect(node.shouldRelayPings()).toBe(true);
      expect(node.canAcceptPeerRole("leaf")).toEqual({
        ok: false,
        code: 503,
        reason: "Too many leaf connections (1 max)",
      });

      node.peers.delete(leafPeer.key);
      expect(node.canAcceptPeerRole("leaf")).toEqual({ ok: true });

      const ultrapeerTwo = makePeer("9.9.9.9:9999");
      ultrapeerTwo.role = "ultrapeer";
      ultrapeerTwo.capabilities.isUltrapeer = true;
      node.peers.set(ultrapeerTwo.key, ultrapeerTwo);

      expect(node.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: false,
        code: 503,
        reason: "Too many ultrapeer connections (2 max)",
      });

      node.peers.delete(ultrapeerTwo.key);
      expect(node.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: true,
      });
    });
  });
});
