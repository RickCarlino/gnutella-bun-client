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

let activeRl: readline.Interface | null = null;
let activeNode: GnutellaServent | null = null;
let monitorEnabled = false;
let monitorIgnoreTokens = new Set<string>();
let promptThrobberFrame = PROMPT_THROBBER_FRAMES.length - 1;
let promptThrobberTimer: ReturnType<typeof setTimeout> | null = null;
let promptThrobberInitial = true;

type MonitorLogEntry = {
  line: string;
  tags: string[];
};

function padNum(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function promptThrobber(): string {
  if (promptThrobberInitial) return " ";
  return PROMPT_THROBBER_FRAMES[promptThrobberFrame] || " ";
}

function peerLimitDisplay(node: GnutellaServent): number {
  const c = node.config();
  if (c.nodeMode === "ultrapeer")
    return c.maxConnections + c.maxLeafConnections;
  if (c.nodeMode === "leaf") return c.maxUltrapeerConnections;
  return c.maxConnections;
}

function promptText(node: GnutellaServent): string {
  const status = node.getStatus();
  const peerLimit = peerLimitDisplay(node);
  const peerWidth = Math.max(
    2,
    String(status.peers).length,
    String(peerLimit).length,
  );
  return `[${padNum(status.peers, peerWidth)}/${padNum(peerLimit, peerWidth)}${promptThrobber()}${padNum(displayResultCount(status.results), 3)}] `;
}

function stopPromptThrobber(): void {
  if (promptThrobberTimer) clearTimeout(promptThrobberTimer);
  promptThrobberTimer = null;
  promptThrobberFrame = PROMPT_THROBBER_FRAMES.length - 1;
  promptThrobberInitial = true;
}

function stepPromptThrobber(): void {
  if (promptThrobberFrame >= PROMPT_THROBBER_FRAMES.length - 1) {
    promptThrobberTimer = null;
    redrawPrompt();
    return;
  }
  promptThrobberTimer = setTimeout(() => {
    promptThrobberFrame++;
    redrawPrompt();
    stepPromptThrobber();
  }, PROMPT_THROBBER_INTERVAL_MS);
}

function throbPrompt(): void {
  promptThrobberInitial = false;
  if (!process.stdin.isTTY) return;
  if (promptThrobberTimer) clearTimeout(promptThrobberTimer);
  promptThrobberFrame = 0;
  redrawPrompt();
  stepPromptThrobber();
}

function redrawPrompt(): void {
  if (!activeRl || !activeNode || !process.stdin.isTTY) return;
  activeRl.setPrompt(promptText(activeNode));
  activeRl.prompt(true);
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
  redrawPrompt();
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

function setMonitorIgnoreTokens(tokens: string[]): void {
  monitorIgnoreTokens = new Set(tokens);
}

function shouldIgnoreMonitorEntry(entry: MonitorLogEntry): boolean {
  return entry.tags.some((tag) => monitorIgnoreTokens.has(tag));
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

function handleNodeEvent(event: GnutellaEvent): void {
  if (!monitorEnabled) {
    if (event.type === "PEER_MESSAGE_RECEIVED") {
      throbPrompt();
      return;
    }
    redrawPrompt();
    return;
  }
  const entry = formatMonitorEvent(event);
  if (entry) {
    if (shouldIgnoreMonitorEntry(entry)) {
      if (event.type === "PEER_MESSAGE_RECEIVED") throbPrompt();
      else redrawPrompt();
      return;
    }
    log(entry.line);
    return;
  }
  redrawPrompt();
}

function printHelp(): void {
  for (const line of CLI_HELP_LINES) log(line);
}

function logConnectResult(result: ConnectPeerResult): void {
  switch (result.status) {
    case "connected":
      log(`peer ${result.peer} connected`);
      return;
    case "already-connected":
      log(`peer ${result.peer} already connected`);
      return;
    case "dialing":
      log(`peer ${result.peer} already dialing`);
      return;
    case "saved":
      log(
        `peer ${result.peer} saved for retry; connect failed: ${result.message}`,
      );
      return;
  }
}

async function handleConnectCommand(
  node: GnutellaServent,
  args: string[],
): Promise<boolean> {
  if (args.length !== 2) throw new Error("usage: connect <host:port>");
  logConnectResult(await node.connectToPeer(args[1]));
  return true;
}

async function handleDownloadCommand(
  node: GnutellaServent,
  args: string[],
): Promise<boolean> {
  if (args.length < 2)
    throw new Error("usage: download <resultNo> [destPath]");
  await node.downloadResult(Number(args[1]), args[2]);
  return true;
}

function pingTtlFor(node: GnutellaServent, args: string[]): number {
  return args[1] ? Number(args[1]) : node.config().defaultPingTtl;
}

async function handleBrowseCommand(
  node: GnutellaServent,
  args: string[],
): Promise<boolean> {
  if (args.length !== 1) throw new Error("usage: browse");
  node.sendQuery("    ", 1);
  log("browse query sent");
  return true;
}

async function handleInfoCommand(
  node: GnutellaServent,
  args: string[],
): Promise<boolean> {
  if (args.length !== 2) throw new Error("usage: info <resultNo>");
  const resultNo = Number(args[1]);
  if (!Number.isInteger(resultNo) || resultNo < 1)
    throw new Error("usage: info <resultNo>");
  printResultInfo(node, resultNo, log);
  return true;
}

type CommandHandler = (
  node: GnutellaServent,
  args: string[],
) => Promise<boolean>;

const COMMAND_ALIASES: Record<string, string> = {
  exit: "quit",
  search: "query",
};

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  help: async () => {
    printHelp();
    return true;
  },
  monitor: async (_node, args) => {
    if (args.length !== 1) throw new Error("usage: monitor");
    monitorEnabled = !monitorEnabled;
    log(`monitor ${monitorEnabled ? "on" : "off"}`);
    return true;
  },
  status: async (node) => {
    printStatus(node, log);
    return true;
  },
  peers: async (node) => {
    printPeers(node, log);
    return true;
  },
  connect: handleConnectCommand,
  shares: async (node) => {
    printShares(node, log);
    return true;
  },
  results: async (node) => {
    printResults(node, log);
    return true;
  },
  clear: async (node) => {
    node.clearResults();
    log("results cleared");
    return true;
  },
  ping: async (node, args) => {
    node.sendPing(pingTtlFor(node, args));
    return true;
  },
  query: async (node, args) => {
    node.sendQuery(args.slice(1).join(" "));
    return true;
  },
  browse: handleBrowseCommand,
  info: handleInfoCommand,
  download: handleDownloadCommand,
  rescan: async (node) => {
    await node.refreshShares();
    printStatus(node, log);
    return true;
  },
  save: async (node) => {
    await node.save();
    log("saved");
    return true;
  },
  sleep: async (_node, args) => {
    await sleep(Number(args[1] || 0) * 1000);
    return true;
  },
  quit: async (node) => {
    await node.stop();
    return false;
  },
};

async function runCommand(
  node: GnutellaServent,
  line: string,
): Promise<boolean> {
  const args = splitArgs(line.trim());
  if (!args.length) return true;
  const rawCommand = args[0].toLowerCase();
  const command = COMMAND_ALIASES[rawCommand] || rawCommand;
  const handler = COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`unknown command: ${rawCommand}`);
  return await handler(node, args);
}

function startRepl(
  node: GnutellaServent,
  execCmds: string[],
): readline.Interface | null {
  runExecCommands(
    execCmds,
    log,
    sleep,
    (cmd) => runCommand(node, cmd),
    errMsg,
  );
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptText(node),
  });
  activeRl = rl;
  activeNode = node;
  rl.on("line", (line) => {
    void runCommand(node, line)
      .then((keep) => {
        if (keep) redrawPrompt();
      })
      .catch((e) => {
        log(errMsg(e));
      });
  });
  rl.on("close", () => {
    if (activeRl === rl) activeRl = null;
    if (activeNode === node) activeNode = null;
    stopPromptThrobber();
  });
  redrawPrompt();
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
  const node = new GnutellaServent(cli.config, doc, {
    onEvent: handleNodeEvent,
  });
  monitorEnabled = false;
  setMonitorIgnoreTokens(node.config().monitorIgnoreEvents);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void node.stop().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await node.start();
  const rl = startRepl(node, cli.exec);
  rl?.on("close", shutdown);
}
