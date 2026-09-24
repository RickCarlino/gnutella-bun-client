import crypto from "node:crypto";

/** Generate a random GUID with Gnutella marker bytes. */
export function randomId16(): Buffer {
  const id = crypto.randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

/** Decode a hexadecimal GUID and set Gnutella marker bytes. */
export function fromHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  const id = Buffer.from(clean, "hex");
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

/** Decode a hexadecimal GUID without altering its bytes. */
export function rawHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  return Buffer.from(clean, "hex");
}
