import { normalizeIpv4 } from "../shared";

function normalizeClientSignature(
  value: string | undefined,
): string | undefined {
  const signature = String(value || "").trim();
  return signature || undefined;
}

/** Find a blocked client signature in handshake headers. */
export function blockedClientSignature(
  headers: Record<string, string>,
): string | undefined {
  for (const key of ["user-agent", "server"] as const) {
    const signature = normalizeClientSignature(headers[key]);
    if (!signature) continue;
    if (signature.toLowerCase().includes("foxy")) return signature;
  }
  return undefined;
}

/** Describe a blocked client and its optional address. */
export function blockedClientMessage(
  signature: string,
  remoteHost?: string,
): string {
  const ip = normalizeIpv4(remoteHost);
  const parts = [`signature=${JSON.stringify(signature)}`];
  if (ip) parts.push(`ip=${ip}`);
  return `blocked client ${parts.join(" ")}`;
}
