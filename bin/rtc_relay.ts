import http from "node:http";
import process from "node:process";

import {
  createGWebCacheServerState,
  handleGWebCacheRequest,
} from "../src/gwebcache/server";
import {
  cleanupRtcRendezvousState,
  createRtcRendezvousState,
  parseRtcAnswerQuery,
  parseRtcRendezvousOfferRequest,
  storeRtcRendezvousAnswer,
  storeRtcRendezvousOffer,
  takeRtcRendezvousAnswer,
  takeRtcRendezvousOffer,
} from "../src/protocol/rtc_rendezvous";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 6346;

type RelayOptions = {
  host?: string;
  onError?: (error: unknown) => void;
  port?: number;
};

type GWebCacheState = ReturnType<typeof createGWebCacheServerState>;
type RtcRelayState = ReturnType<typeof createRtcRendezvousState>;

function relayUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

function response(
  res: http.ServerResponse,
  statusCode: number,
  body: Uint8Array = Buffer.alloc(0),
  headers: Record<string, string> = {},
): void {
  res.statusCode = statusCode;
  res.setHeader("Connection", "close");
  res.setHeader("Content-Length", String(body.length));
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(body);
}

function requestTarget(req: http.IncomingMessage): URL | undefined {
  if (!req.url) return undefined;
  try {
    return new URL(req.url, "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function headerRecord(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(",");
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function badUsage(message: string): never {
  throw new Error(message);
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) badUsage(`invalid port: ${raw}`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    badUsage(`invalid port: ${raw}`);
  }
  return port;
}

function cliOptionValue(
  argv: string[],
  index: number,
  flag: string,
): { nextIndex: number; value: string } {
  const current = argv[index] || "";
  const equalsPrefix = `${flag}=`;
  if (current.startsWith(equalsPrefix)) {
    return {
      nextIndex: index,
      value: current.slice(equalsPrefix.length),
    };
  }
  const value = argv[index + 1];
  if (!value) badUsage(`missing value for ${flag}`);
  return {
    nextIndex: index + 1,
    value,
  };
}

function isHelpArg(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function isHostArg(arg: string): boolean {
  return arg === "--host" || arg.startsWith("--host=");
}

function isPortArg(arg: string): boolean {
  return arg === "--port" || arg.startsWith("--port=");
}

function parseRelayCli(argv: string[]): {
  help: boolean;
  host: string;
  port: number;
} {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] || "";
    if (isHelpArg(arg)) {
      return { help: true, host, port };
    }
    if (isHostArg(arg)) {
      const parsed = cliOptionValue(argv, index, "--host");
      host = parsed.value || DEFAULT_HOST;
      index = parsed.nextIndex;
      continue;
    }
    if (isPortArg(arg)) {
      const parsed = cliOptionValue(argv, index, "--port");
      port = parsePort(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    badUsage(`unknown argument: ${arg}`);
  }

  return { help: false, host, port };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: bun run bin/rtc_relay.ts [--host HOST] [--port PORT]",
      "",
      "Runs the standalone RTC rendezvous relay and GWebCache.",
      "It serves /rtc/offer, /rtc/answer, and spec-2 GWebCache queries on the same base URL.",
      "It does not join the Gnutella network as a normal search or download node.",
      "",
      `Defaults: --host ${DEFAULT_HOST} --port ${DEFAULT_PORT}`,
      "",
    ].join("\n"),
  );
}

function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

async function handleOfferPost(
  state: RtcRelayState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const offer = parseRtcRendezvousOfferRequest(
    headerRecord(req.headers),
    body,
  );
  if (!offer) {
    response(res, 400);
    return;
  }
  storeRtcRendezvousOffer(state, offer);
  response(res, 202);
}

function handleOfferGet(
  state: RtcRelayState,
  res: http.ServerResponse,
  target: URL,
): void {
  const targetServentIdHex =
    target.searchParams.get("target")?.toLowerCase() || "";
  if (!/^[0-9a-f]{32}$/.test(targetServentIdHex)) {
    response(res, 400);
    return;
  }
  const offer = takeRtcRendezvousOffer(state, targetServentIdHex);
  if (!offer) {
    response(res, 204);
    return;
  }
  response(res, 200, Buffer.from(offer.sdp, "utf8"), {
    "Content-Type": "application/sdp",
    "X-RTC-Cookie": offer.cookieHex,
    "X-RTC-File-Index": String(offer.fileIndex),
    "X-RTC-Query-ID": offer.queryIdHex,
    "X-RTC-RID": offer.ridHex,
    "X-RTC-Token": offer.tokenHex,
  });
}

async function handleAnswerPost(
  state: RtcRelayState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
): Promise<void> {
  const query = parseRtcAnswerQuery(target);
  const sdp = (await readBody(req)).toString("utf8");
  if (!query || !sdp.trim()) {
    response(res, 400);
    return;
  }
  response(
    res,
    storeRtcRendezvousAnswer(
      state,
      {
        ridHex: query.ridHex,
        sdp,
      },
      query.tokenHex,
    )
      ? 202
      : 404,
  );
}

function handleAnswerGet(
  state: RtcRelayState,
  res: http.ServerResponse,
  target: URL,
): void {
  const query = parseRtcAnswerQuery(target);
  if (!query) {
    response(res, 400);
    return;
  }
  const answer = takeRtcRendezvousAnswer(
    state,
    query.ridHex,
    query.tokenHex,
  );
  if (answer === null) {
    response(res, 404);
    return;
  }
  if (!answer) {
    response(res, 204);
    return;
  }
  response(res, 200, Buffer.from(answer.sdp, "utf8"), {
    "Content-Type": "application/sdp",
  });
}

async function handleRtcRelayRequest(
  rtcState: RtcRelayState,
  webCacheState: GWebCacheState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const target = requestTarget(req);
  if (!target) {
    response(res, 404);
    return;
  }

  if (!target.pathname.startsWith("/rtc/")) {
    handleWebCacheRelayRequest(webCacheState, req, res, target);
    return;
  }

  await handleRtcPathRequest(rtcState, req, res, target);
}

function handleWebCacheRelayRequest(
  state: GWebCacheState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
): void {
  const webCacheReply = handleGWebCacheRequest(
    state,
    (req.method || "GET").toUpperCase(),
    target,
  );
  if (!webCacheReply) {
    response(res, 404);
    return;
  }
  response(
    res,
    webCacheReply.statusCode,
    webCacheReply.body,
    webCacheReply.headers,
  );
}

async function handleRtcPathRequest(
  state: RtcRelayState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: URL,
): Promise<void> {
  cleanupRtcRendezvousState(state);

  switch (`${(req.method || "GET").toUpperCase()} ${target.pathname}`) {
    case "POST /rtc/offer":
      await handleOfferPost(state, req, res);
      return;
    case "GET /rtc/offer":
      handleOfferGet(state, res, target);
      return;
    case "POST /rtc/answer":
      await handleAnswerPost(state, req, res, target);
      return;
    case "GET /rtc/answer":
      handleAnswerGet(state, res, target);
      return;
    default:
      response(res, 404);
  }
}

export async function startRtcRelayServer(options: RelayOptions = {}) {
  const rtcState = createRtcRendezvousState();
  const webCacheState = createGWebCacheServerState();
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const onError = options.onError || logError;
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        await handleRtcRelayRequest(rtcState, webCacheState, req, res);
      } catch (error) {
        try {
          onError(error);
        } catch {
          // ignore logging callback failures and preserve the relay response
        }
        if (!res.headersSent) {
          response(res, 500);
          return;
        }
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve relay listen address");
  }

  return {
    host,
    port: address.port,
    server,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    url: relayUrl(host, address.port),
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseRelayCli(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const relay = await startRtcRelayServer(options);
  process.stdout.write(
    `RTC relay and GWebCache listening on ${relay.host}:${relay.port}; advertise ${relay.url} or your public IPv4 equivalent\n`,
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void relay.stop().finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    logError(error);
    process.exit(1);
  });
}
