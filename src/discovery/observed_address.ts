import { parseRemoteIpHeader } from "../connections/policy";
import { ipv4Subnet16, isRoutableIpv4, normalizeIpv4 } from "../shared";

type ObservedAdvertisedHost = {
  observedHost: string;
  subnet: string;
};

/** Extract a public address report and reporter subnet. */
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
