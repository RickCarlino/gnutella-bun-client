import { normalizeIpv4 } from "../shared";

function normalizeClientSignature(
  value: string | undefined,
): string | undefined {
  const signature = String(value || "").trim();
  return signature || undefined;
}

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

export function blockedClientMessage(
  signature: string,
  remoteHost?: string,
): string {
  const ip = normalizeIpv4(remoteHost);
  const parts = [`signature=${JSON.stringify(signature)}`];
  if (ip) parts.push(`ip=${ip}`);
  return `blocked client ${parts.join(" ")}`;
}
