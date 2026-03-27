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
let promptThrobberFrame = PROMPT_THROBBER_FRAMES.length - 1;
let promptThrobberTimer: ReturnType<typeof setTimeout> | null = null;
let promptThrobberInitial = true;

function padNum(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function promptThrobber(): string {
  if (promptThrobberInitial) return " ";
  return PROMPT_THROBBER_FRAMES[promptThrobberFrame] || " ";
}

function promptText(node: GnutellaServent): string {
  const status = node.getStatus();
  return `[${padNum(status.peers, 2)}/${padNum(node.config().maxConnections, 2)}${promptThrobber()}${padNum(displayResultCount(status.results), 3)}] Gnutella> `;
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

function handleNodeEvent(event: GnutellaEvent): void {
  if (event.type === "PEER_MESSAGE_RECEIVED") {
    throbPrompt();
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
