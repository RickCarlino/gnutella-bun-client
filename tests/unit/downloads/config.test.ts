import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { loadDoc, writeDoc } from "../../../src/protocol";
import { makeNode, withTempDir } from "../../helpers/protocol";
import { TestServent as GnutellaServent } from "../../helpers/servent";

test("body idle timeout defaults to 60 seconds without changing connection timeout", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "config.json"));
    expect(node.config().downloadIdleTimeoutMs).toBe(60_000);
    expect(node.config().downloadTimeoutMs).toBe(15_000);
  });
});

test("loads and persists a configurable body idle timeout", async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        config: {
          listen_ip: "127.0.0.1",
          download_idle_timeout_ms: 90_000,
        },
      }),
    );
    const doc = await loadDoc(configPath);
    const node = new GnutellaServent(configPath, doc);
    expect(node.config().downloadIdleTimeoutMs).toBe(90_000);
    expect(node.config().downloadTimeoutMs).toBe(15_000);
    await writeDoc(configPath, doc);
    expect(
      JSON.parse(await fs.readFile(configPath, "utf8")).config
        .download_idle_timeout_ms,
    ).toBe(90_000);
    node.updateRuntimeConfig({ downloadIdleTimeoutMs: 120_000 });
    await node.save();
    const reloaded = new GnutellaServent(
      configPath,
      await loadDoc(configPath),
    );
    expect(reloaded.config().downloadIdleTimeoutMs).toBe(120_000);
  });
});

test.each([0, -1, "invalid"])(
  "ignores invalid body idle timeout %s",
  async (value) => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "config.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ config: { download_idle_timeout_ms: value } }),
      );
      const node = new GnutellaServent(
        configPath,
        await loadDoc(configPath),
      );
      expect(node.config().downloadIdleTimeoutMs).toBe(60_000);
    });
  },
);
