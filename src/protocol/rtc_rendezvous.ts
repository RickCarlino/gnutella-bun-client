import net from "node:net";

import type { RtcRendezvousEndpoint } from "./rtc_signal";

export type RtcRendezvousOffer = {
  cookieHex: string;
  fileIndex: number;
  queryIdHex: string;
  ridHex: string;
  sdp: string;
  targetServentIdHex: string;
  tokenHex: string;
};

type RtcRendezvousAnswer = {
  ridHex: string;
  sdp: string;
};

type StoredOffer = {
  createdAtMs: number;
  offer: RtcRendezvousOffer;
};

type StoredAnswer = {
  answer: RtcRendezvousAnswer;
  createdAtMs: number;
};

type StoredSession = {
  createdAtMs: number;
  tokenHex: string;
};

type RtcRendezvousState = {
  offers: Map<string, StoredOffer[]>;
  answers: Map<string, StoredAnswer>;
  sessions: Map<string, StoredSession>;
};

const RTC_RENDEZVOUS_ENTRY_LIMIT = 40;
const RTC_RENDEZVOUS_TTL_MS = 60_000;

function hexField(
  value: string | null,
  bytes: number,
): string | undefined {
  const width = bytes * 2;
  return value && new RegExp(`^[0-9a-f]{${width}}$`, "i").test(value)
    ? value.toLowerCase()
    : undefined;
}

function integerField(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function joinRtcRendezvousUrl(base: string, pathname: string): string {
  return `${base}${pathname}`;
}

function sdpBody(value: string): string | undefined {
  return value.trim() ? value : undefined;
}

function parseRtcOfferHeaders(headers: Headers, sdp: string) {
  const cookieHex = hexField(headers.get("x-rtc-cookie"), 20);
  const fileIndex = integerField(headers.get("x-rtc-file-index"));
  const queryIdHex = hexField(headers.get("x-rtc-query-id"), 16);
  const ridHex = hexField(headers.get("x-rtc-rid"), 16);
  const targetServentIdHex = hexField(headers.get("x-rtc-target"), 16);
  const tokenHex = hexField(headers.get("x-rtc-token"), 16);
  if (
    !cookieHex ||
    fileIndex == null ||
    !queryIdHex ||
    !ridHex ||
    !targetServentIdHex ||
    !tokenHex ||
    !sdpBody(sdp)
  ) {
    return undefined;
  }
  return {
    cookieHex,
    fileIndex,
    queryIdHex,
    ridHex,
    sdp,
    targetServentIdHex,
    tokenHex,
  } satisfies RtcRendezvousOffer;
}

function parseRtcOfferResponse(response: Response, sdp: string) {
  const cookieHex = hexField(response.headers.get("x-rtc-cookie"), 20);
  const fileIndex = integerField(response.headers.get("x-rtc-file-index"));
  const queryIdHex = hexField(response.headers.get("x-rtc-query-id"), 16);
  const ridHex = hexField(response.headers.get("x-rtc-rid"), 16);
  const tokenHex = hexField(response.headers.get("x-rtc-token"), 16);
  if (
    !cookieHex ||
    fileIndex == null ||
    !queryIdHex ||
    !ridHex ||
    !tokenHex ||
    !sdpBody(sdp)
  ) {
    return undefined;
  }
  return {
    cookieHex,
    fileIndex,
    queryIdHex,
    ridHex,
    sdp,
    targetServentIdHex: "",
    tokenHex,
  } satisfies RtcRendezvousOffer;
}

export function normalizeRtcRendezvousUrl(
  value: string,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:") return undefined;
    if (net.isIP(url.hostname) !== 4) return undefined;
    url.username = "";
    url.password = "";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return undefined;
  }
}

export function sanitizeRtcRendezvousUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const normalized = normalizeRtcRendezvousUrl(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= RTC_RENDEZVOUS_ENTRY_LIMIT) break;
  }
  return out;
}

export function hostedRtcRendezvousUrl(
  host: string,
  port: number,
): string {
  return `http://${host}:${port}`;
}

export function rtcRendezvousUrlForEndpoint(
  endpoint: RtcRendezvousEndpoint,
): string {
  return hostedRtcRendezvousUrl(endpoint.host, endpoint.port);
}

function rtcRendezvousEndpointForUrl(
  url: string,
): RtcRendezvousEndpoint | undefined {
  const normalized = normalizeRtcRendezvousUrl(url);
  if (!normalized) return undefined;
  const parsed = new URL(normalized);
  const port = parsed.port ? Number(parsed.port) : 80;
  if (net.isIP(parsed.hostname) !== 4 || !Number.isInteger(port)) {
    return undefined;
  }
  return {
    host: parsed.hostname,
    port,
  };
}

export function advertisedRtcRendezvousEndpoints(
  urls: string[],
): RtcRendezvousEndpoint[] {
  return sanitizeRtcRendezvousUrls(urls)
    .map((url) => rtcRendezvousEndpointForUrl(url))
    .filter((endpoint): endpoint is RtcRendezvousEndpoint => !!endpoint);
}

export function createRtcRendezvousState(): RtcRendezvousState {
  return {
    offers: new Map<string, StoredOffer[]>(),
    answers: new Map<string, StoredAnswer>(),
    sessions: new Map<string, StoredSession>(),
  };
}

export function cleanupRtcRendezvousState(
  state: RtcRendezvousState,
  nowMs = Date.now(),
): void {
  for (const [target, queue] of state.offers) {
    const live = queue.filter(
      (entry) => nowMs - entry.createdAtMs <= RTC_RENDEZVOUS_TTL_MS,
    );
    if (live.length) state.offers.set(target, live);
    else state.offers.delete(target);
  }
  for (const [ridHex, answer] of state.answers) {
    if (nowMs - answer.createdAtMs > RTC_RENDEZVOUS_TTL_MS) {
      state.answers.delete(ridHex);
    }
  }
  for (const [ridHex, session] of state.sessions) {
    if (nowMs - session.createdAtMs > RTC_RENDEZVOUS_TTL_MS) {
      state.sessions.delete(ridHex);
      state.answers.delete(ridHex);
    }
  }
}

export function storeRtcRendezvousOffer(
  state: RtcRendezvousState,
  offer: RtcRendezvousOffer,
): void {
  cleanupRtcRendezvousState(state);
  const stored: StoredOffer = {
    createdAtMs: Date.now(),
    offer: {
      ...offer,
      cookieHex: offer.cookieHex.toLowerCase(),
      queryIdHex: offer.queryIdHex.toLowerCase(),
      ridHex: offer.ridHex.toLowerCase(),
      targetServentIdHex: offer.targetServentIdHex.toLowerCase(),
      tokenHex: offer.tokenHex.toLowerCase(),
    },
  };
  const queue = state.offers.get(stored.offer.targetServentIdHex) || [];
  queue.push(stored);
  state.offers.set(stored.offer.targetServentIdHex, queue);
  state.sessions.set(stored.offer.ridHex, {
    createdAtMs: stored.createdAtMs,
    tokenHex: stored.offer.tokenHex,
  });
}

export function takeRtcRendezvousOffer(
  state: RtcRendezvousState,
  targetServentIdHex: string,
): RtcRendezvousOffer | undefined {
  cleanupRtcRendezvousState(state);
  const target = targetServentIdHex.toLowerCase();
  const queue = state.offers.get(target) || [];
  const next = queue.shift();
  if (queue.length) state.offers.set(target, queue);
  else state.offers.delete(target);
  return next?.offer;
}

export function storeRtcRendezvousAnswer(
  state: RtcRendezvousState,
  answer: RtcRendezvousAnswer,
  tokenHex: string,
): boolean {
  cleanupRtcRendezvousState(state);
  const ridHex = answer.ridHex.toLowerCase();
  const token = tokenHex.toLowerCase();
  const session = state.sessions.get(ridHex);
  if (!session || session.tokenHex !== token) return false;
  state.answers.set(ridHex, {
    answer: {
      ridHex,
      sdp: answer.sdp,
    },
    createdAtMs: Date.now(),
  });
  return true;
}

export function takeRtcRendezvousAnswer(
  state: RtcRendezvousState,
  ridHex: string,
  tokenHex: string,
): RtcRendezvousAnswer | undefined | null {
  cleanupRtcRendezvousState(state);
  const rid = ridHex.toLowerCase();
  const token = tokenHex.toLowerCase();
  const session = state.sessions.get(rid);
  if (!session || session.tokenHex !== token) return null;
  const answer = state.answers.get(rid);
  if (!answer) return undefined;
  state.answers.delete(rid);
  state.sessions.delete(rid);
  return answer.answer;
}

export async function postRtcRendezvousOffer(
  url: string,
  offer: RtcRendezvousOffer,
): Promise<void> {
  const response = await fetch(joinRtcRendezvousUrl(url, "/rtc/offer"), {
    body: offer.sdp,
    headers: {
      "content-type": "application/sdp",
      "x-rtc-cookie": offer.cookieHex,
      "x-rtc-file-index": String(offer.fileIndex),
      "x-rtc-query-id": offer.queryIdHex,
      "x-rtc-rid": offer.ridHex,
      "x-rtc-target": offer.targetServentIdHex,
      "x-rtc-token": offer.tokenHex,
    },
    method: "POST",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `rtc rendezvous offer rejected with ${response.status}`,
    );
  }
}

export async function pollRtcRendezvousOffer(
  url: string,
  targetServentIdHex: string,
): Promise<RtcRendezvousOffer | undefined> {
  const target = targetServentIdHex.toLowerCase();
  const response = await fetch(
    `${joinRtcRendezvousUrl(url, "/rtc/offer")}?target=${encodeURIComponent(target)}`,
    {
      redirect: "manual",
    },
  );
  if (response.status === 204) return undefined;
  if (!response.ok) {
    throw new Error(
      `rtc rendezvous offer poll failed with ${response.status}`,
    );
  }
  const offer = parseRtcOfferResponse(response, await response.text());
  if (!offer) throw new Error("invalid rtc rendezvous offer");
  return {
    ...offer,
    targetServentIdHex: target,
  };
}

export async function postRtcRendezvousAnswer(
  url: string,
  answer: RtcRendezvousAnswer,
  tokenHex: string,
): Promise<void> {
  const response = await fetch(
    `${joinRtcRendezvousUrl(url, "/rtc/answer")}?rid=${encodeURIComponent(answer.ridHex.toLowerCase())}&token=${encodeURIComponent(tokenHex.toLowerCase())}`,
    {
      body: answer.sdp,
      headers: {
        "content-type": "application/sdp",
      },
      method: "POST",
      redirect: "manual",
    },
  );
  if (!response.ok) {
    throw new Error(
      `rtc rendezvous answer rejected with ${response.status}`,
    );
  }
}

export async function waitForRtcRendezvousAnswer(
  url: string,
  ridHex: string,
  tokenHex: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<RtcRendezvousAnswer> {
  const deadline = Date.now() + timeoutMs;
  const rid = ridHex.toLowerCase();
  const token = tokenHex.toLowerCase();
  while (Date.now() < deadline) {
    const response = await fetch(
      `${joinRtcRendezvousUrl(url, "/rtc/answer")}?rid=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`,
      {
        redirect: "manual",
      },
    );
    if (response.status === 204) {
      await sleep(250);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `rtc rendezvous answer wait failed with ${response.status}`,
      );
    }
    const sdp = await response.text();
    if (!sdpBody(sdp)) throw new Error("invalid rtc rendezvous answer");
    return { ridHex: rid, sdp };
  }
  throw new Error("rtc rendezvous answer timed out");
}

export function parseRtcRendezvousOfferRequest(
  headers: Record<string, string>,
  body: Buffer,
): RtcRendezvousOffer | undefined {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    responseHeaders.set(key, value);
  }
  return parseRtcOfferHeaders(responseHeaders, body.toString("utf8"));
}

export function parseRtcAnswerQuery(
  target: URL,
): { ridHex: string; tokenHex: string } | undefined {
  const ridHex = hexField(target.searchParams.get("rid"), 16);
  const tokenHex = hexField(target.searchParams.get("token"), 16);
  return ridHex && tokenHex ? { ridHex, tokenHex } : undefined;
}
