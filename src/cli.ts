import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import {
  CLI_HELP_LINES,
  PROMPT_THROBBER_FRAMES,
  PROMPT_THROBBER_INTERVAL_MS,
} from "./const";
import {
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
import type { GnutellaEvent } from "./types";

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
  return `[${padNum(status.peers, 2)}/${padNum(node.config().maxConnections, 2)}${promptThrobber()}${padNum(status.results, 6)}] Gnutella> `;
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

async function runCommand(
  node: GnutellaServent,
  line: string,
): Promise<boolean> {
  const args = splitArgs(line.trim());
  if (!args.length) return true;
  const cmd = args[0].toLowerCase();
  switch (cmd) {
    case "help":
      printHelp();
      return true;
    case "status":
      printStatus(node, log);
      return true;
    case "peers":
      printPeers(node, log);
      return true;
    case "connect": {
      if (args.length !== 2) throw new Error("usage: connect <host:port>");
      const result = await node.connectToPeer(args[1]);
      if (result.status === "connected")
        log(`peer ${result.peer} connected`);
      else if (result.status === "already-connected")
        log(`peer ${result.peer} already connected`);
      else if (result.status === "dialing")
        log(`peer ${result.peer} already dialing`);
      else
        log(
          `peer ${result.peer} saved for retry; connect failed: ${result.message}`,
        );
      return true;
    }
    case "shares":
      printShares(node, log);
      return true;
    case "results":
      printResults(node, log);
      return true;
    case "clear":
      node.clearResults();
      log("results cleared");
      return true;
    case "ping":
      node.sendPing(
        args[1] ? Number(args[1]) : node.config().defaultPingTtl,
      );
      return true;
    case "query":
    case "search":
      node.sendQuery(args.slice(1).join(" "));
      return true;
    case "download":
      if (args.length < 2)
        throw new Error("usage: download <resultNo> [destPath]");
      await node.downloadResult(Number(args[1]), args[2]);
      return true;
    case "rescan":
      await node.refreshShares();
      printStatus(node, log);
      return true;
    case "save":
      await node.save();
      log("saved");
      return true;
    case "sleep":
      await sleep(Number(args[1] || 0) * 1000);
      return true;
    case "quit":
    case "exit":
      await node.stop();
      return false;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
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
