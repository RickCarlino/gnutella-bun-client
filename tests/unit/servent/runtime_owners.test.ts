import { expect, test } from "bun:test";
import path from "node:path";
import { defaultDoc } from "../../../src/config/document";
import { RuntimeConfiguration } from "../../../src/config/runtime";
import { LocalAddress } from "../../../src/discovery/local_address";
import { GnutellaServent } from "../../../src/protocol";
import { withTempDir } from "../../helpers/protocol";

test("configuration owns its values and returns detached snapshots", () => {
  const file = "/tmp/gnutonium-owner-config.json";
  const overrides = { blockedIps: ["127.0.0.2"] };
  const configuration = new RuntimeConfiguration(
    file,
    defaultDoc(file),
    overrides,
  );
  overrides.blockedIps.push("127.0.0.3");
  const snapshot = configuration.snapshot();
  snapshot.blockedIps.push("127.0.0.4");
  expect(configuration.snapshot().blockedIps).toEqual(["127.0.0.2"]);
  const updated = configuration.update({ blockedIps: ["127.0.0.5"] });
  updated.blockedIps.length = 0;
  expect(configuration.snapshot().blockedIps).toEqual(["127.0.0.5"]);
});

test("local-address observations require three distinct reporting subnets", () => {
  const config = {
    listenHost: "127.0.0.1",
    listenPort: 6346,
    advertisedHost: "",
    advertisedPort: 0,
  };
  const address = new LocalAddress(() => config);
  address.trackPendingAdvertisedHost("44.55.66.77", "1.2");
  address.trackPendingAdvertisedHost("44.55.66.77", "1.2");
  address.trackPendingAdvertisedHost("44.55.66.77", "2.3");
  expect(address.currentAdvertisedHost()).toBe("127.0.0.1");
  address.trackPendingAdvertisedHost("44.55.66.77", "3.4");
  expect(address.currentAdvertisedHost()).toBe("44.55.66.77");
  config.advertisedHost = "55.66.77.88";
  config.advertisedPort = 7000;
  expect(address.currentAdvertisedHost()).toBe("55.66.77.88");
  expect(address.currentAdvertisedPort()).toBe(7000);
});

test("constructor input and discovery snapshots cannot mutate live peer state", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "config.json");
    const document = defaultDoc(file);
    document.state.peers = { "127.0.0.2:6346": 0 };
    const node = new GnutellaServent(file, document, {
      runtimeConfig: { listenHost: "127.0.0.1" },
    });
    document.state.peers = {};
    const saved = node.getKnownPeers();
    saved.length = 0;
    expect(node.getKnownPeers()).toEqual(["127.0.0.2:6346"]);
  });
});
