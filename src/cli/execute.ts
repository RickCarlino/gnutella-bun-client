import type { MonitorMode } from "../cli_monitor";
import {
  printPeers,
  printQueries,
  printShares,
  printStatus,
} from "../cli_shared";
import type { GnutellaServent } from "../servent";
import type {
  BlockIpResult,
  ConnectPeerResult,
  UnblockIpResult,
} from "../types";
import {
  emptyOutcome,
  executeSelection,
  type BatchNode,
  type CommandOutcome,
} from "./batch";
import { commandHelp, type ParsedCommand } from "./commands";

export type CommandNode = BatchNode &
  Pick<
    GnutellaServent,
    | "getStatus"
    | "getPeers"
    | "getShares"
    | "getBlockedIps"
    | "blockIp"
    | "unblockIp"
    | "connectToPeer"
    | "browsePeer"
    | "sendQuery"
    | "sendPing"
    | "config"
    | "refreshShares"
    | "save"
  >;
export type ExecutionContext = {
  node: CommandNode;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  shutdown: () => Promise<void>;
  monitor: { get: () => MonitorMode; set: (mode: MonitorMode) => void };
};
function connectMessage(result: ConnectPeerResult): string {
  switch (result.status) {
    case "connected":
      return `peer ${result.peer} connected`;
    case "already-connected":
      return `peer ${result.peer} already connected`;
    case "dialing":
      return `peer ${result.peer} already dialing`;
    case "saved":
      return `peer ${result.peer} saved for retry; connect failed: ${result.message}`;
    case "blocked":
      return `peer ${result.peer} is blocked`;
  }
}
function blockMessage(result: BlockIpResult): string {
  if (result.status === "already-blocked")
    return `ip ${result.ip} already blocked`;
  const details = [
    [result.droppedPeers, "peer"],
    [result.removedKnownPeers, "known peer"],
  ] as const;
  const removed = details
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
  return `ip ${result.ip} blocked${removed.length ? `; removed ${removed.join(", ")}` : ""}`;
}
function unblockMessage(result: UnblockIpResult): string {
  return `ip ${result.ip} ${result.status === "not-blocked" ? "is not blocked" : "unblocked"}`;
}
type PlainCommand = Exclude<ParsedCommand, { selector: unknown }>;
async function executeNetwork(
  command: Extract<
    PlainCommand,
    { address: string } | { name: "query" } | { name: "ping" }
  >,
  context: ExecutionContext,
): Promise<void> {
  const { node, log } = context;
  switch (command.name) {
    case "block":
      log(blockMessage(node.blockIp(command.address)));
      return;
    case "unblock":
      log(unblockMessage(node.unblockIp(command.address)));
      return;
    case "connect":
      log(connectMessage(await node.connectToPeer(command.address)));
      return;
    case "browse": {
      const search = await node.browsePeer(command.address);
      log(`q${search.number}: ${JSON.stringify(search.search)}`);
      return;
    }
    case "query": {
      const search = node.sendQuery(command.text);
      log(
        search
          ? `q${search.number}: ${JSON.stringify(search.search)}`
          : "no peers connected",
      );
      return;
    }
    case "ping":
      node.sendPing(command.ttl ?? node.config().defaultPingTtl);
      return;
  }
}
async function executePlain(
  command: PlainCommand,
  context: ExecutionContext,
): Promise<void> {
  if (
    "address" in command ||
    command.name === "query" ||
    command.name === "ping"
  )
    return executeNetwork(command, context);
  if (command.name === "sleep")
    return context.sleep(command.seconds * 1000);
  if (command.name === "monitor") {
    setMonitor(command.mode, context);
    return;
  }
  return executeUtility(command, context);
}
async function executeUtility(
  command: Extract<
    PlainCommand,
    {
      name:
        | "help"
        | "status"
        | "peers"
        | "blocked"
        | "shares"
        | "queries"
        | "rescan"
        | "save"
        | "quit";
    }
  >,
  context: ExecutionContext,
): Promise<void> {
  const { node, log } = context;
  if (command.name === "rescan") {
    await node.refreshShares();
    printStatus(node, log);
    return;
  }
  if (command.name === "save") {
    await node.save();
    log("saved");
    return;
  }
  if (command.name === "quit") {
    await context.shutdown();
    return;
  }
  return executeDisplay(command.name, context);
}
function executeDisplay(
  name: "help" | "status" | "peers" | "blocked" | "shares" | "queries",
  { node, log }: ExecutionContext,
): void {
  switch (name) {
    case "help":
      log(commandHelp());
      return;
    case "status":
      printStatus(node, log);
      return;
    case "peers":
      printPeers(node, log);
      return;
    case "blocked":
      log(node.getBlockedIps().join("\n") || "no blocked IPs");
      return;
    case "shares":
      printShares(node, log);
      return;
    case "queries":
      printQueries(node.getSearches(), log);
      return;
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled command ${exhaustive}`);
    }
  }
}
/** Execute a validated typed command through owner APIs. */
export async function executeCommand(
  command: ParsedCommand,
  context: ExecutionContext,
): Promise<CommandOutcome> {
  if ("selector" in command)
    return executeSelection(command, context.node, context.log);
  await executePlain(command, context);
  return emptyOutcome(command.name !== "quit");
}

function setMonitor(
  mode: Extract<ParsedCommand, { name: "monitor" }>["mode"],
  context: ExecutionContext,
): void {
  const chosen = mode ?? (context.monitor.get() === "off" ? "all" : "off");
  context.monitor.set(chosen === "on" ? "all" : chosen);
  context.log(
    `monitor ${context.monitor.get() === "all" ? "on" : context.monitor.get()}`,
  );
}
