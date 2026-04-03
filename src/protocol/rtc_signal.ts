import { randomBytes } from "node:crypto";
import net from "node:net";

import { parseHttpDownloadHeader } from "./codec";
import {
  binaryField,
  encodeSingleGgep,
  integerField,
  parseTlv,
  readIntegerField,
  readRepeatedBinaryFields,
  readSingleField,
  readSingleGgep,
  requireBufferLength,
} from "./rtc_signal_shared";
import {
  RTCPeerConnection,
  type RTCDataChannel,
  type WeriftPeerConnection,
} from "./werift_local";

const RTC_SIGNAL_VERSION = 1;
const RTC_COOKIE_BYTES = 20;
const RTC_RENDEZVOUS_ENDPOINT_BYTES = 7;
const RTC_RENDEZVOUS_ENDPOINT_LIMIT = 4;
const TLV_VER = 0x01;
const TLV_COOKIE = 0x05;
const TLV_RTEP = 0x0f;

type ParsedHttpResponse = {
  body: Buffer;
  finalStart: number;
  headerText: string;
  remaining: number;
};

type RtcPeerConnectionConfig = {
  iceAdditionalHostAddresses?: string[];
  iceInterfaceAddresses?: {
    udp4?: string;
    udp6?: string;
  };
  icePortRange?: [number, number];
  iceServers?: Array<{ urls: string }>;
  iceUseIpv4?: boolean;
  iceUseIpv6?: boolean;
};

export type RtcRendezvousEndpoint = {
  host: string;
  port: number;
};

type RtcQueryCapability = {
  version: number;
};

type RtcHitCapability = {
  version: number;
  cookie: Buffer;
  rendezvousEndpoints: RtcRendezvousEndpoint[];
};

export const RTC_CHANNEL_LABEL = "GNUT";
export const RTC_CHANNEL_PROTOCOL = "";

function normalizeRtcRendezvousEndpoints(
  endpoints: RtcRendezvousEndpoint[] | undefined,
): RtcRendezvousEndpoint[] {
  const seen = new Set<string>();
  const out: RtcRendezvousEndpoint[] = [];
  for (const endpoint of endpoints || []) {
    if (net.isIP(endpoint.host) !== 4) continue;
    if (!Number.isInteger(endpoint.port) || endpoint.port <= 0) continue;
    const key = `${endpoint.host}:${endpoint.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      host: endpoint.host,
      port: endpoint.port,
    });
    if (out.length >= RTC_RENDEZVOUS_ENDPOINT_LIMIT) break;
  }
  return out;
}

function encodeRtcRendezvousEndpoint(
  endpoint: RtcRendezvousEndpoint,
): Buffer {
  const normalized = normalizeRtcRendezvousEndpoints([endpoint])[0];
  if (!normalized) throw new Error("invalid RTEP");
  const payload = Buffer.alloc(RTC_RENDEZVOUS_ENDPOINT_BYTES);
  payload[0] = 0x00;
  for (const [index, octet] of normalized.host.split(".").entries()) {
    payload[index + 1] = Number(octet) & 0xff;
  }
  payload.writeUInt16BE(normalized.port & 0xffff, 5);
  return payload;
}

function decodeRtcRendezvousEndpoint(
  raw: Buffer,
): RtcRendezvousEndpoint | undefined {
  if (raw.length !== RTC_RENDEZVOUS_ENDPOINT_BYTES) return undefined;
  if (raw[0] !== 0x00) return undefined;
  const host = `${raw[1]}.${raw[2]}.${raw[3]}.${raw[4]}`;
  const port = raw.readUInt16BE(5);
  return normalizeRtcRendezvousEndpoints([{ host, port }])[0];
}

export function randomRtcId(): Buffer {
  return randomBytes(16);
}

export function sanitizeRtcStunUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!/^stun:/i.test(trimmed)) continue;
    if (trimmed.length > 256) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 4) break;
  }
  return out;
}

export function encodeRtcQueryGgep(
  input: {
    version?: number;
  } = {},
): Buffer {
  return encodeSingleGgep("RTCQ", [
    integerField(TLV_VER, input.version ?? RTC_SIGNAL_VERSION),
  ]);
}

export function parseRtcQueryGgep(raw: Buffer): RtcQueryCapability {
  const fields = parseTlv(readSingleGgep(raw, "RTCQ"));
  return {
    version: readIntegerField(fields, TLV_VER, "VER"),
  };
}

export function encodeRtcHitGgep(input: {
  cookie: Buffer;
  rendezvousEndpoints: RtcRendezvousEndpoint[];
  version?: number;
}): Buffer {
  const cookie = requireBufferLength(
    Buffer.from(input.cookie),
    RTC_COOKIE_BYTES,
    "COOKIE",
  );
  const rendezvousEndpoints = normalizeRtcRendezvousEndpoints(
    input.rendezvousEndpoints,
  );
  return encodeSingleGgep("RTCH", [
    integerField(TLV_VER, input.version ?? RTC_SIGNAL_VERSION),
    binaryField(TLV_COOKIE, cookie),
    ...rendezvousEndpoints.map((endpoint) =>
      binaryField(TLV_RTEP, encodeRtcRendezvousEndpoint(endpoint)),
    ),
  ]);
}

export function parseRtcHitGgep(raw: Buffer): RtcHitCapability {
  const fields = parseTlv(readSingleGgep(raw, "RTCH"));
  const rendezvousEndpoints = readRepeatedBinaryFields(fields, TLV_RTEP)
    .map((value) => decodeRtcRendezvousEndpoint(value))
    .filter((endpoint): endpoint is RtcRendezvousEndpoint => !!endpoint);
  return {
    version: readIntegerField(fields, TLV_VER, "VER"),
    cookie: requireBufferLength(
      readSingleField(fields, TLV_COOKIE, "COOKIE"),
      RTC_COOKIE_BYTES,
      "COOKIE",
    ),
    rendezvousEndpoints,
  };
}

export function createRtcPeerConnection(
  config: Partial<RtcPeerConnectionConfig> = {},
): WeriftPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceAdditionalHostAddresses: ["127.0.0.1"],
    ...config,
  });
}

export function waitForRtcDataChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = 15_000,
): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `RTC data channel ${channel.label} did not open in time`,
        ),
      );
    }, timeoutMs);
    channel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

export class HttpByteStreamBuffer {
  private buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  takeRequest(): string | undefined {
    const header = this.takeHeaderText();
    if (!header) return undefined;
    return header;
  }

  takeResponse(requestedStart: number): ParsedHttpResponse | undefined {
    const header = this.peekHeaderText();
    if (!header) return undefined;
    const parsed = parseHttpDownloadHeader(
      header.headerText,
      requestedStart,
    );
    const totalLength = header.bodyOffset + parsed.remaining;
    if (this.buffer.length < totalLength) return undefined;
    const body = Buffer.from(
      this.buffer.subarray(header.bodyOffset, totalLength),
    );
    this.buffer = Buffer.from(this.buffer.subarray(totalLength));
    return {
      body,
      finalStart: parsed.finalStart,
      headerText: header.headerText,
      remaining: parsed.remaining,
    };
  }

  private peekHeaderText():
    | { bodyOffset: number; headerText: string }
    | undefined {
    const marker = this.buffer.indexOf("\r\n\r\n");
    if (marker === -1) return undefined;
    const bodyOffset = marker + 4;
    const headerText = this.buffer
      .subarray(0, bodyOffset)
      .toString("latin1");
    return { bodyOffset, headerText };
  }

  private takeHeaderText(): string | undefined {
    const header = this.peekHeaderText();
    if (!header) return undefined;
    this.buffer = Buffer.from(this.buffer.subarray(header.bodyOffset));
    return header.headerText;
  }
}
