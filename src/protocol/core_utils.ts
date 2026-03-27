import crypto from "node:crypto";

import { TYPE } from "../const";

export function randomId16(): Buffer {
  const id = crypto.randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

export function seenKey(
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): string {
  const base = `${payloadType}:${descriptorIdHex}`;
  if (
    (payloadType === TYPE.PONG || payloadType === TYPE.QUERY_HIT) &&
    payload
  ) {
    const digest = crypto.createHash("sha1").update(payload).digest("hex");
    return `${base}:${digest}`;
  }
  return base;
}

export function fromHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  const id = Buffer.from(clean, "hex");
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

export function rawHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  return Buffer.from(clean, "hex");
}
