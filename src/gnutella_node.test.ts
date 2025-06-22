import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GnutellaNode } from "./gnutella_node";

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "gnutella-node-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("loadSharedFiles", () => {
  test("creates directory when missing", async () => {
    const node = new GnutellaNode();
    await node.loadSharedFiles();
    expect(existsSync(join(dir, "gnutella-library"))).toBe(true);
    const files = node.getSharedFiles();
    expect(files.length).toBe(0);
  });

  test("loads files from library", async () => {
    const lib = join(dir, "gnutella-library");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "song.mp3"), "a");
    writeFileSync(join(lib, "doc.txt"), "b");

    const node = new GnutellaNode();
    await node.loadSharedFiles();
    const filenames = node.getSharedFiles().map((f) => f.filename);
    expect(filenames.sort()).toEqual(["doc.txt", "song.mp3"]);
  });
});
