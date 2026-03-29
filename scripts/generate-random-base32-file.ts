#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { base32Encode } from "../src/protocol/content_urn";

type CliOptions = {
  outDir: string;
  chars: number;
};

function usage(): string {
  return [
    "usage: bun scripts/generate-random-base32-file.ts [--dir <path>] [--chars <count>]",
    "",
    "Creates one 8.3-style file named XXXXXXXX.txt where XXXXXXXX is random base32",
    "and fills it with random base32 text.",
  ].join("\n");
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseCli(argv: string[]): CliOptions {
  let outDir = ".";
  let chars = 4096;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      outDir = argv[++i] || outDir;
      continue;
    }
    if (arg === "--chars") {
      chars = parsePositiveInt(argv[++i] || "", "--chars");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    outDir: path.resolve(outDir),
    chars,
  };
}

function randomBase32Chars(count: number): string {
  let out = "";
  while (out.length < count) {
    const bytesNeeded = Math.max(
      1,
      Math.ceil(((count - out.length) * 5) / 8),
    );
    out += base32Encode(crypto.randomBytes(bytesNeeded));
  }
  return out.slice(0, count);
}

async function uniqueRandomFilePath(outDir: string): Promise<string> {
  for (;;) {
    const candidate = path.join(outDir, `${randomBase32Chars(8)}.txt`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  await fs.mkdir(options.outDir, { recursive: true });
  const filePath = await uniqueRandomFilePath(options.outDir);
  const body = `${randomBase32Chars(options.chars)}\n`;
  await fs.writeFile(filePath, body, "utf8");
  console.log(filePath);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
