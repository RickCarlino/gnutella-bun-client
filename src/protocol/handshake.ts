import net from "node:net";

import { ipv4Subnet16, isRoutableIpv4, normalizeIpv4 } from "../shared";
import { parseRemoteIpHeader } from "../handshake_policy";

type ObservedAdvertisedHost = {
  observedHost: string;
  subnet: string;
};

export {
  buildHandshakeBlock,
  describeHandshakeResponse,
  findHeaderEnd,
  hasToken,
  mergeHeaders,
  parseHandshakeBlock,
  parsePeerHeaderList,
} from "../handshake_policy";

export function observedAdvertisedHostCandidate(
  headers: Record<string, string>,
  reporterHost?: string,
): ObservedAdvertisedHost | undefined {
  const observedHost = parseRemoteIpHeader(
    headers["remote-ip"] || headers["x-remote-ip"],
  );
  const reporter = normalizeIpv4(reporterHost);
  if (!observedHost || !reporter) return undefined;
  if (!isRoutableIpv4(observedHost) || !isRoutableIpv4(reporter))
    return undefined;
  const subnet = ipv4Subnet16(reporter);
  if (!subnet) return undefined;
  return { observedHost, subnet };
}

export function socketCanEnd(socket: net.Socket): boolean {
  return (
    !socket.destroyed &&
    !(socket as net.Socket & { writableEnded?: boolean }).writableEnded &&
    !(socket as net.Socket & { ended?: boolean }).ended
  );
}

export function parseHttpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line
      .slice(idx + 1)
      .trim();
  }
  return out;
}
