import { lowerCaseHeaders, parseRemoteIpHeader } from "./headers";
import type { RejectHandshakePolicy } from "./types";

export function buildRejectHeaders(
  policy: RejectHandshakePolicy,
): Record<string, string> {
  const headers = lowerCaseHeaders(policy.extraHeaders || {});
  const observedRemote = parseRemoteIpHeader(policy.remoteIp);
  const tryPeers = policy.tryPeers || [];
  if (observedRemote) headers["remote-ip"] = observedRemote;
  if (tryPeers.length) {
    const value = tryPeers.join(",");
    headers["x-try"] = value;
    headers["x-try-ultrapeers"] = value;
  }
  return headers;
}
