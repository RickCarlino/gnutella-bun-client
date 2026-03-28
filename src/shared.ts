import net from "node:net";
import fsp from "node:fs/promises";
import path from "node:path";

export function ts(): string {
  return new Date().toISOString();
}

export function errMsg(e: any): string {
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

export function normalizePeer(host: string, port: number): string {
  return `${host.trim()}:${port}`;
}

export function parsePeer(
  s: string,
): { host: string; port: number } | null {
  const t = String(s || "").trim();
  const m = /^([^:]+):(\d+)$/.exec(t);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

export function normalizeIpv4(
  host: string | undefined,
): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim();
  if (net.isIPv4(trimmed)) return trimmed;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  return undefined;
}

function ipv4Octets(host: string): number[] | null {
  const normalized = normalizeIpv4(host);
  if (!normalized) return null;
  return normalized.split(".").map((part) => Number(part));
}

type Ipv4Matcher = (parts: readonly number[]) => boolean;

const NON_ROUTABLE_IPV4_MATCHERS: Ipv4Matcher[] = [
  ([a]) => a === 0 || a >= 224,
  ([a]) => a === 10 || a === 127,
  ([a, b]) => a === 100 && b >= 64 && b <= 127,
  ([a, b]) => a === 169 && b === 254,
  ([a, b]) => a === 172 && b >= 16 && b <= 31,
  ([a, b]) => a === 192 && b === 168,
  ([a, b, c]) => a === 192 && b === 0 && c === 0,
  ([a, b, c]) => a === 192 && b === 0 && c === 2,
  ([a, b]) => a === 198 && (b === 18 || b === 19),
  ([a, b, c]) => a === 198 && b === 51 && c === 100,
  ([a, b, c]) => a === 203 && b === 0 && c === 113,
];

export function isUnspecifiedIpv4(host: string): boolean {
  return normalizeIpv4(host) === "0.0.0.0";
}

export function isRoutableIpv4(host: string): boolean {
  const parts = ipv4Octets(host);
  return (
    !!parts && !NON_ROUTABLE_IPV4_MATCHERS.some((match) => match(parts))
  );
}

export function ipv4Subnet16(host: string): string | undefined {
  const parts = ipv4Octets(host);
  if (!parts) return undefined;
  return `${parts[0]}.${parts[1]}`;
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

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await rec(abs);
      else if (ent.isFile()) out.push(abs);
    }
  }
  if (await fileExists(root)) await rec(root);
  return out;
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
