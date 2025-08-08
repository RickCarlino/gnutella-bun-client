type Scope =
  | "Main"
  | "HTTP"
  | "Parser"
  | "Socket"
  | "Router"
  | "Server"
  | "Node"
  | "PeerStore"
  | "QRP";

function ts(): string {
  const d = new Date();
  const iso = d.toISOString();
  return iso.substring(11, 23); // HH:MM:SS.mmm
}

function stringify(meta?: unknown): string {
  if (meta === undefined || meta === null) {
    return "";
  }
  try {
    if (typeof meta === "string") {
      return meta;
    }
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export const log = {
  debug(scope: Scope, msg: string, meta?: unknown): void {
    // Always verbose for now (no config)
    console.debug(`[${ts()}][${scope}] ${msg}`, stringify(meta));
  },
  info(scope: Scope, msg: string, meta?: unknown): void {
    console.log(`[${ts()}][${scope}] ${msg}`, stringify(meta));
  },
  warn(scope: Scope, msg: string, meta?: unknown): void {
    console.warn(`[${ts()}][${scope}] ${msg}`, stringify(meta));
  },
  error(scope: Scope, msg: string, meta?: unknown): void {
    console.error(`[${ts()}][${scope}] ${msg}`, stringify(meta));
  },
};

export type { Scope };
