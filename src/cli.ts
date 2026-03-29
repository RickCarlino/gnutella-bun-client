import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import {
  CLI_HELP_LINES,
  PROMPT_THROBBER_FRAMES,
  PROMPT_THROBBER_INTERVAL_MS,
} from "./const";
import {
  displayResultCount,
  errMsg,
  parseCli,
  printPeers,
  printResultInfo,
  printResults,
  printShares,
  printStatus,
  runExecCommands,
} from "./cli_shared";
import { GnutellaServent, loadDoc, writeDoc } from "./protocol";
import { sleep, splitArgs } from "./shared";
import type { ConnectPeerResult, GnutellaEvent } from "./types";

type MonitorLogEntry = {
  line: string;
  tags: string[];
};

type CliSession = {
  rl: readline.Interface | null;
  node: GnutellaServent;
  monitorEnabled: boolean;
  monitorIgnoreTokens: Set<string>;
  promptFrame: number;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptInitial: boolean;
};

function createCliSession(node: GnutellaServent): CliSession {
  return {
    rl: null,
    node,
    monitorEnabled: false,
    monitorIgnoreTokens: new Set<string>(),
    promptFrame: PROMPT_THROBBER_FRAMES.length - 1,
    promptTimer: null,
    promptInitial: true,
  };
}

function padNum(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function promptThrobber(session: CliSession): string {
  if (session.promptInitial) return " ";
  return PROMPT_THROBBER_FRAMES[session.promptFrame] || " ";
}

function peerLimitDisplay(node: GnutellaServent): number {
  const c = node.config();
  if (c.nodeMode === "ultrapeer")
    return c.maxConnections + c.maxLeafConnections;
  if (c.nodeMode === "leaf") return c.maxUltrapeerConnections;
  return c.maxConnections;
}

function promptText(session: CliSession): string {
  const status = session.node.getStatus();
  const peerLimit = peerLimitDisplay(session.node);
  const peerWidth = Math.max(
    2,
    String(status.peers).length,
    String(peerLimit).length,
  );
  return `[${padNum(status.peers, peerWidth)}/${padNum(peerLimit, peerWidth)}${promptThrobber(session)}${padNum(displayResultCount(status.results), 3)}] `;
}

function stopPromptThrobber(session: CliSession): void {
  if (session.promptTimer) clearTimeout(session.promptTimer);
  session.promptTimer = null;
  session.promptFrame = PROMPT_THROBBER_FRAMES.length - 1;
  session.promptInitial = true;
}

function stepPromptThrobber(session: CliSession): void {
  if (session.promptFrame >= PROMPT_THROBBER_FRAMES.length - 1) {
    session.promptTimer = null;
    redrawPrompt(session);
    return;
  }
  session.promptTimer = setTimeout(() => {
    session.promptFrame++;
    redrawPrompt(session);
    stepPromptThrobber(session);
  }, PROMPT_THROBBER_INTERVAL_MS);
}

function throbPrompt(session: CliSession): void {
  session.promptInitial = false;
  if (!process.stdin.isTTY) return;
  if (session.promptTimer) clearTimeout(session.promptTimer);
  session.promptFrame = 0;
  redrawPrompt(session);
  stepPromptThrobber(session);
}

function redrawPrompt(session: CliSession): void {
  if (!session.rl || !process.stdin.isTTY) return;
  session.rl.setPrompt(promptText(session));
  session.rl.prompt(true);
}

function log(session: CliSession, msg: string): void {
  process.stdout.write(`${msg}\n`);
  redrawPrompt(session);
}

function shortDescriptorId(hex: string): string {
  return hex.slice(0, 8);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function describePeer(
  event: Extract<GnutellaEvent, { peer: { remoteLabel: string } }>,
): string {
  const parts = [
    event.peer.remoteLabel,
    `dir=${event.peer.outbound ? "out" : "in"}`,
    `flags=${event.peer.compression ? "Z" : "-"}${event.peer.tls ? "L" : "-"}`,
  ];
  if (event.peer.userAgent)
    parts.push(`agent=${quoted(event.peer.userAgent)}`);
  return parts.join(" ");
}

function monitorEntry(line: string, ...tags: string[]): MonitorLogEntry {
  return { line, tags };
}

function setMonitorIgnoreTokens(
  session: CliSession,
  tokens: string[],
): void {
  session.monitorIgnoreTokens = new Set(tokens);
}

function shouldIgnoreMonitorEntry(
  session: CliSession,
  entry: MonitorLogEntry,
): boolean {
  return entry.tags.some((tag) => session.monitorIgnoreTokens.has(tag));
}

function formatLifecycleMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "STARTED":
      return monitorEntry(
        `[started] listen=${event.listenHost}:${event.listenPort} advertised=${event.advertisedHost}:${event.advertisedPort}`,
        "STARTED",
      );
    case "IDENTITY":
      return monitorEntry(
        `[identity] serventId=${event.serventIdHex}`,
        "IDENTITY",
      );
    case "SHARES_REFRESHED":
      return monitorEntry(
        `[shares] count=${event.count} totalKiB=${event.totalKBytes}`,
        "SHARES_REFRESHED",
      );
    case "MAINTENANCE_ERROR":
      return monitorEntry(
        `[maintenance] op=${event.operation} message=${quoted(event.message)}`,
        "MAINTENANCE_ERROR",
      );
    case "PROBE_REJECTED":
      return monitorEntry(
        `[probe rejected] message=${quoted(event.message)}`,
        "PROBE_REJECTED",
      );
  }
}

function formatHandshakeMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  if (event.type !== "HANDSHAKE_DEBUG") return;
  return monitorEntry(
    `[hs ${event.direction} ${event.phase}] peer=${event.peer} ${event.message}`,
    "HANDSHAKE",
    `HANDSHAKE:${event.direction.toUpperCase()}`,
    `HANDSHAKE:${event.phase.toUpperCase()}`,
  );
}

function formatPeerMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "PEER_CONNECTED":
      return monitorEntry(
        `[peer up] ${describePeer(event)}`,
        "PEER_CONNECTED",
      );
    case "PEER_DROPPED":
      return monitorEntry(
        `[peer down] ${describePeer(event)} message=${quoted(event.message)}`,
        "PEER_DROPPED",
      );
    case "PEER_MESSAGE_RECEIVED":
      return monitorEntry(
        `[rx] ${event.payloadTypeName} id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} len=${event.payloadLength} from=${event.peer.remoteLabel}`,
        "PEER_MESSAGE_RECEIVED",
        event.payloadTypeName,
        `RX:${event.payloadTypeName}`,
      );
    case "PEER_MESSAGE_SENT":
      return monitorEntry(
        `[tx] ${event.payloadTypeName} id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} len=${event.payloadLength} to=${event.peer.remoteLabel}`,
        "PEER_MESSAGE_SENT",
        event.payloadTypeName,
        `TX:${event.payloadTypeName}`,
      );
    case "PONG":
      return monitorEntry(
        `[pong] ${event.ip}:${event.port} files=${event.files} kbytes=${event.kbytes}`,
        "PONG",
        "EVENT:PONG",
      );
  }
}

function formatQueryMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "QUERY_RECEIVED":
      return monitorEntry(
        `[query rx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} hops=${event.hops} from=${event.peer.remoteLabel} urns=${event.urns.length} search=${quoted(event.search)}`,
        "QUERY_RECEIVED",
        "EVENT:QUERY_RECEIVED",
        "QUERY",
        "RX:QUERY",
      );
    case "QUERY_RESULT":
      return monitorEntry(
        `[query hit] #${event.hit.resultNo} via=${event.hit.viaPeerKey} remote=${event.hit.remoteHost}:${event.hit.remotePort} size=${event.hit.fileSize} name=${quoted(event.hit.fileName)}`,
        "QUERY_RESULT",
        "EVENT:QUERY_RESULT",
        "QUERY_HIT",
      );
    case "PING_SENT":
      return monitorEntry(
        `[ping tx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl}`,
        "PING_SENT",
        "EVENT:PING_SENT",
        "PING",
        "TX:PING",
      );
    case "QUERY_SENT":
      return monitorEntry(
        `[query tx] id=${shortDescriptorId(event.descriptorIdHex)} ttl=${event.ttl} search=${quoted(event.search)}`,
        "QUERY_SENT",
        "EVENT:QUERY_SENT",
        "QUERY",
        "TX:QUERY",
      );
    case "QUERY_SKIPPED":
      return monitorEntry(
        `[query skip] reason=${event.reason}`,
        "QUERY_SKIPPED",
      );
  }
}

function formatTransferMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  switch (event.type) {
    case "PUSH_REQUESTED":
      return monitorEntry(
        `[push requested] fileIndex=${event.fileIndex} ip=${event.ip}:${event.port} name=${quoted(event.fileName)}`,
        "PUSH_REQUESTED",
        "PUSH",
      );
    case "PUSH_CALLBACK_FAILED":
      return monitorEntry(
        `[push callback failed] message=${quoted(event.message)}`,
        "PUSH_CALLBACK_FAILED",
      );
    case "PUSH_UPLOAD_FAILED":
      return monitorEntry(
        `[push upload failed] message=${quoted(event.message)}`,
        "PUSH_UPLOAD_FAILED",
      );
    case "DOWNLOAD_SUCCEEDED":
      return monitorEntry(
        `[download ok] mode=${event.mode} result=${event.resultNo} remote=${event.remoteHost}:${event.remotePort} path=${quoted(event.destPath)}`,
        "DOWNLOAD_SUCCEEDED",
      );
    case "DOWNLOAD_DIRECT_FAILED":
      return monitorEntry(
        `[download failed] result=${event.resultNo} remote=${event.remoteHost}:${event.remotePort} path=${quoted(event.destPath)} message=${quoted(event.message)}`,
        "DOWNLOAD_DIRECT_FAILED",
      );
  }
}

function formatMonitorEvent(
  event: GnutellaEvent,
): MonitorLogEntry | undefined {
  return (
    formatLifecycleMonitorEvent(event) ||
    formatHandshakeMonitorEvent(event) ||
    formatPeerMonitorEvent(event) ||
    formatQueryMonitorEvent(event) ||
    formatTransferMonitorEvent(event)
  );
}

function handleNodeEvent(session: CliSession, event: GnutellaEvent): void {
  if (!session.monitorEnabled) {
    if (event.type === "PEER_MESSAGE_RECEIVED") {
      throbPrompt(session);
      return;
    }
    redrawPrompt(session);
    return;
  }
  const entry = formatMonitorEvent(event);
  if (entry) {
    if (shouldIgnoreMonitorEntry(session, entry)) {
      if (event.type === "PEER_MESSAGE_RECEIVED") throbPrompt(session);
      else redrawPrompt(session);
      return;
    }
    log(session, entry.line);
    return;
  }
  redrawPrompt(session);
}

function printHelp(session: CliSession): void {
  for (const line of CLI_HELP_LINES) log(session, line);
}

function logConnectResult(
  session: CliSession,
  result: ConnectPeerResult,
): void {
  switch (result.status) {
    case "connected":
      log(session, `peer ${result.peer} connected`);
      return;
    case "already-connected":
      log(session, `peer ${result.peer} already connected`);
      return;
    case "dialing":
      log(session, `peer ${result.peer} already dialing`);
      return;
    case "saved":
      log(
        session,
        `peer ${result.peer} saved for retry; connect failed: ${result.message}`,
      );
      return;
  }
}

async function handleConnectCommand(
  session: CliSession,
  args: string[],
): Promise<boolean> {
  if (args.length !== 2) throw new Error("usage: connect <host:port>");
  logConnectResult(session, await session.node.connectToPeer(args[1]));
  return true;
}

async function handleDownloadCommand(
  session: CliSession,
  args: string[],
): Promise<boolean> {
  if (args.length < 2)
    throw new Error("usage: download <resultNo> [destPath]");
  await session.node.downloadResult(Number(args[1]), args[2]);
  return true;
}

function pingTtlFor(node: GnutellaServent, args: string[]): number {
  return args[1] ? Number(args[1]) : node.config().defaultPingTtl;
}

async function handleBrowseCommand(
  session: CliSession,
  args: string[],
): Promise<boolean> {
  if (args.length !== 1) throw new Error("usage: browse");
  session.node.sendQuery("    ", 1);
  log(session, "browse query sent");
  return true;
}

async function handleInfoCommand(
  session: CliSession,
  args: string[],
): Promise<boolean> {
  if (args.length !== 2) throw new Error("usage: info <resultNo>");
  const resultNo = Number(args[1]);
  if (!Number.isInteger(resultNo) || resultNo < 1)
    throw new Error("usage: info <resultNo>");
  printResultInfo(session.node, resultNo, (msg) => log(session, msg));
  return true;
}

type CommandHandler = (
  session: CliSession,
  args: string[],
) => Promise<boolean>;

const COMMAND_ALIASES: Record<string, string> = {
  exit: "quit",
  search: "query",
};

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  help: async (session) => {
    printHelp(session);
    return true;
  },
  monitor: async (session, args) => {
    if (args.length !== 1) throw new Error("usage: monitor");
    session.monitorEnabled = !session.monitorEnabled;
    log(session, `monitor ${session.monitorEnabled ? "on" : "off"}`);
    return true;
  },
  status: async (session) => {
    printStatus(session.node, (msg) => log(session, msg));
    return true;
  },
  peers: async (session) => {
    printPeers(session.node, (msg) => log(session, msg));
    return true;
  },
  connect: handleConnectCommand,
  shares: async (session) => {
    printShares(session.node, (msg) => log(session, msg));
    return true;
  },
  results: async (session) => {
    printResults(session.node, (msg) => log(session, msg));
    return true;
  },
  clear: async (session) => {
    session.node.clearResults();
    log(session, "results cleared");
    return true;
  },
  ping: async (session, args) => {
    session.node.sendPing(pingTtlFor(session.node, args));
    return true;
  },
  query: async (session, args) => {
    session.node.sendQuery(args.slice(1).join(" "));
    return true;
  },
  browse: handleBrowseCommand,
  info: handleInfoCommand,
  download: handleDownloadCommand,
  rescan: async (session) => {
    await session.node.refreshShares();
    printStatus(session.node, (msg) => log(session, msg));
    return true;
  },
  save: async (session) => {
    await session.node.save();
    log(session, "saved");
    return true;
  },
  sleep: async (_node, args) => {
    await sleep(Number(args[1] || 0) * 1000);
    return true;
  },
  quit: async (session) => {
    await session.node.stop();
    return false;
  },
};

async function runCommand(
  session: CliSession,
  line: string,
): Promise<boolean> {
  const args = splitArgs(line.trim());
  if (!args.length) return true;
  const rawCommand = args[0].toLowerCase();
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`unknown command: ${rawCommand}`);
  return await handler(session, args);
}

function startRepl(
  session: CliSession,
  execCmds: string[],
): readline.Interface | null {
  runExecCommands(
    execCmds,
    (msg) => log(session, msg),
    sleep,
    (cmd) => runCommand(session, cmd),
    errMsg,
  );
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText(session),
  });
  session.rl = rl;
  rl.on("line", (line) => {
    void runCommand(session, line)
      .then((keep) => {
        if (keep) redrawPrompt(session);
      })
      .catch((e) => {
        log(session, errMsg(e));
      });
  });
  rl.on("close", () => {
    if (session.rl === rl) session.rl = null;
    stopPromptThrobber(session);
  });
  redrawPrompt(session);
  return rl;
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv, "gnutella.json");
  if (cli.command === "init") {
    const doc = await loadDoc(cli.config);
    await writeDoc(cli.config, doc);
    console.log(path.resolve(cli.config));
    return;
  }
  if (cli.command !== "run")
    throw new Error(`unsupported command ${cli.command}`);

  const doc = await loadDoc(cli.config);
  const node = new GnutellaServent(cli.config, doc);
  const session = createCliSession(node);
  node.subscribe((event) => handleNodeEvent(session, event));
  setMonitorIgnoreTokens(session, node.config().monitorIgnoreEvents);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void node.stop().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await node.start();
  const rl = startRepl(session, cli.exec);
  rl?.on("close", shutdown);
}
