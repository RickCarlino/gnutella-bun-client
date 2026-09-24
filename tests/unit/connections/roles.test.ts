import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  makeNode,
  makePeer,
  overrideRuntimeConfig,
  withTempDir,
} from "../../helpers/protocol";

describe("protocol node topology", () => {
  test("classifies peers and reports role counts", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const leafPeer = makePeer("1.1.1.1:1111");
      const ultrapeerPeer = makePeer("2.2.2.2:2222");
      ultrapeerPeer.role = "ultrapeer";
      ultrapeerPeer.capabilities.isUltrapeer = true;

      node.connections.peers.set(leafPeer.key, leafPeer);
      node.connections.peers.set(ultrapeerPeer.key, ultrapeerPeer);

      expect(node.connections.nodeMode()).toBe("leaf");
      expect(
        node.connections.classifyPeerRole({
          ...leafPeer.capabilities,
          isUltrapeer: false,
        }),
      ).toBe("leaf");

      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
      });

      expect(node.connections.nodeMode()).toBe("ultrapeer");
      expect(
        node.connections.classifyPeerRole({
          ...leafPeer.capabilities,
          isUltrapeer: true,
        }),
      ).toBe("ultrapeer");
      expect(node.connections.peerRole(leafPeer)).toBe("leaf");
      expect(node.connections.countPeersByRole("leaf")).toBe(1);
      expect(node.connections.countPeersByRole("ultrapeer")).toBe(1);
      expect(node.connections.connectedLeafCount()).toBe(1);
      expect(node.connections.connectedMeshPeerCount()).toBe(1);
      expect(node.connections.isLeafPeer(leafPeer)).toBe(true);
      expect(node.connections.isLeafPeer(ultrapeerPeer)).toBe(false);
      expect(node.connections.isMeshPeer(leafPeer)).toBe(false);
      expect(node.connections.isMeshPeer(ultrapeerPeer)).toBe(true);
    });
  });

  test("enforces shielded leaf admission rules and slot counts", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, { maxUltrapeerConnections: 2 });

      const ultrapeerOne = makePeer("3.3.3.3:3333");
      ultrapeerOne.role = "ultrapeer";
      ultrapeerOne.capabilities.isUltrapeer = true;
      node.connections.peers.set(ultrapeerOne.key, ultrapeerOne);
      node.connections.dialing.add("4.4.4.4:4444");

      expect(node.connections.availableDialSlots()).toBe(0);
      expect(node.connections.shouldRelayQueries()).toBe(false);
      expect(node.connections.shouldRelayPings()).toBe(false);
      expect(node.connections.canAcceptPeerRole("leaf")).toEqual({
        ok: false,
        code: 503,
        reason: "Shielded leaf node (2 ultrapeers max)",
      });
      expect(node.connections.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: true,
      });

      const ultrapeerTwo = makePeer("5.5.5.5:5555");
      ultrapeerTwo.role = "ultrapeer";
      ultrapeerTwo.capabilities.isUltrapeer = true;
      node.connections.peers.set(ultrapeerTwo.key, ultrapeerTwo);

      expect(node.connections.canAcceptPeerRole("ultrapeer")).toEqual({
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
      node.connections.peers.set(leafPeer.key, leafPeer);
      node.connections.peers.set(ultrapeerOne.key, ultrapeerOne);
      node.connections.dialing.add("8.8.8.8:8888");

      expect(node.connections.availableDialSlots()).toBe(0);
      expect(node.connections.shouldRelayQueries()).toBe(true);
      expect(node.connections.shouldRelayPings()).toBe(true);
      expect(node.connections.canAcceptPeerRole("leaf")).toEqual({
        ok: false,
        code: 503,
        reason: "Too many leaf connections (1 max)",
      });

      node.connections.peers.delete(leafPeer.key);
      expect(node.connections.canAcceptPeerRole("leaf")).toEqual({
        ok: true,
      });

      const ultrapeerTwo = makePeer("9.9.9.9:9999");
      ultrapeerTwo.role = "ultrapeer";
      ultrapeerTwo.capabilities.isUltrapeer = true;
      node.connections.peers.set(ultrapeerTwo.key, ultrapeerTwo);

      expect(node.connections.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: false,
        code: 503,
        reason: "Too many ultrapeer connections (2 max)",
      });

      node.connections.peers.delete(ultrapeerTwo.key);
      expect(node.connections.canAcceptPeerRole("ultrapeer")).toEqual({
        ok: true,
      });
    });
  });
});
