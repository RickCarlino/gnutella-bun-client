import fsp from "node:fs/promises";
import path from "node:path";

export {
  ipv4Subnet16,
  isRoutableIpv4,
  isUnspecifiedIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
} from "./peer_address";

export function ts(): string {
  return new Date().toISOString();
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function toBuffer(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  try {
    await fsp.mkdir(p, { recursive: true });
  } catch (e) {
    // Bun's compiled Windows runtime can report EEXIST for an already-existing
    // directory on first-run config creation.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw e;
  }
}

async function* walkFilesRecursive(
  dir: string,
): AsyncGenerator<string, void, void> {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of ents) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFilesRecursive(abs);
    else if (ent.isFile()) yield abs;
  }
}

export async function* walkFilesIter(
  root: string,
): AsyncGenerator<string, void, void> {
  if (!(await fileExists(root))) return;
  yield* walkFilesRecursive(root);
}

export function ipToBytesBE(ip: string): Buffer {
  const parts = ip.split(".").map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

export function ipToBytesLE(ip: string): Buffer {
  return Buffer.from([...ipToBytesBE(ip)].reverse());
}

export function bytesToIpBE(buf: Buffer): string {
  if (buf.length !== 4)
    throw new Error(`expected 4 bytes for IPv4, got ${buf.length}`);
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

export function bytesToIpLE(buf: Buffer): string {
  if (buf.length !== 4)
    throw new Error(`expected 4 bytes for IPv4, got ${buf.length}`);
  return `${buf[3]}.${buf[2]}.${buf[1]}.${buf[0]}`;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/\0]/g, "_").replace(/^\.+$/, "_");
}

type SplitArgsState = {
  out: string[];
  cur: string;
  quote: string;
  esc: boolean;
  pending: boolean;
};

function flushSplitArg(state: SplitArgsState): void {
  if (!state.pending) return;
  state.out.push(state.cur);
  state.cur = "";
  state.pending = false;
}

function consumeEscapedArgChar(
  state: SplitArgsState,
  ch: string,
): boolean {
  if (!state.esc) return false;
  state.cur += ch;
  state.esc = false;
  state.pending = true;
  return true;
}

function consumeEscapeStart(state: SplitArgsState, ch: string): boolean {
  if (ch !== "\\") return false;
  state.esc = true;
  state.pending = true;
  return true;
}

function consumeQuotedArgChar(state: SplitArgsState, ch: string): boolean {
  if (!state.quote) return false;
  if (ch === state.quote) state.quote = "";
  else state.cur += ch;
  return true;
}

function consumeQuoteStart(state: SplitArgsState, ch: string): boolean {
  if (ch !== '"' && ch !== "'") return false;
  state.quote = ch;
  state.pending = true;
  return true;
}

function consumeArgWhitespace(state: SplitArgsState, ch: string): boolean {
  if (!/\s/.test(ch)) return false;
  flushSplitArg(state);
  return true;
}

export function splitArgs(line: string): string[] {
  const state: SplitArgsState = {
    out: [],
    cur: "",
    quote: "",
    esc: false,
    pending: false,
  };
  for (const ch of line) {
    if (consumeEscapedArgChar(state, ch)) continue;
    if (consumeEscapeStart(state, ch)) continue;
    if (consumeQuotedArgChar(state, ch)) continue;
    if (consumeQuoteStart(state, ch)) continue;
    if (consumeArgWhitespace(state, ch)) continue;
    state.cur += ch;
    state.pending = true;
  }
  if (state.esc) state.cur += "\\";
  flushSplitArg(state);
  return state.out;
}
