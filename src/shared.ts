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

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
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

export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let esc = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) (out.push(cur), (cur = ""));
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
