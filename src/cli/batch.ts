import {
  printDownloadInfo,
  printDownloads,
  printResultInfo,
  printResultMagnet,
  printResults,
} from "../cli_shared";
import type { GnutellaServent } from "../servent";
import { errMsg } from "../shared";
import type { ParsedCommand } from "./commands";
import { resolveSelector, takeSnapshot, type Target } from "./resolve";

type SelectionCommand = Extract<ParsedCommand, { selector: unknown }>;
export type BatchNode = Pick<
  GnutellaServent,
  | "getDownloadJobs"
  | "getSearches"
  | "getResults"
  | "getResult"
  | "downloadResult"
  | "pauseDownload"
  | "resumeDownload"
  | "removeDownload"
  | "clearResults"
>;
type TargetOutcome = {
  target: string;
  status: "success" | "noop" | "failure";
  reason?: string;
};
export type CommandOutcome = {
  keepRunning: boolean;
  successes: number;
  noops: number;
  failures: number;
  targets: TargetOutcome[];
  createdJobs: string[];
};
export function emptyOutcome(keepRunning = true): CommandOutcome {
  return {
    keepRunning,
    successes: 0,
    noops: 0,
    failures: 0,
    targets: [],
    createdJobs: [],
  };
}
function targetLabel(target: Target): string {
  return target.domain === "searches" ? `q${target.number}` : target.id;
}
function ensureSearch(node: BatchNode, target: Target) {
  const search = node.getSearches().find((s) => s.id === target.id);
  if (!search) throw new Error(`no such search ${targetLabel(target)}`);
  return search;
}
function ensureDownload(node: BatchNode, target: Target) {
  const job = node.getDownloadJobs().find((j) => j.id === target.id);
  if (!job) throw new Error(`no such download ${target.id}`);
  return job;
}
async function jobAction(
  command: SelectionCommand,
  target: Target,
  node: BatchNode,
  log: (line: string) => void,
): Promise<boolean> {
  const before = ensureDownload(node, target).status;
  switch (command.name) {
    case "pause":
    case "resume": {
      const job = await (command.name === "pause"
        ? node.pauseDownload(target.id)
        : node.resumeDownload(target.id));
      log(`download ${job.id} ${job.status}`);
      // A repeated status alone is not a no-op: resume can reset retries.
      return before === "complete" && job.status === "complete";
    }
    case "clear":
    case "remove":
      await node.removeDownload(target.id);
      log(`download ${target.id} removed`);
      return false;
    case "info":
      printDownloadInfo(node, target.id, log);
      return false;
    default:
      throw new Error(`unsupported download action ${command.name}`);
  }
}
async function act(
  command: SelectionCommand,
  target: Target,
  node: BatchNode,
  log: (line: string) => void,
  jobs: Set<string>,
): Promise<boolean> {
  if (target.domain === "downloads")
    return jobAction(command, target, node, log);
  if (target.domain === "searches") {
    const search = ensureSearch(node, target);
    if (command.name === "clear") node.clearResults(search.id);
    else {
      log(`q${search.number}: ${JSON.stringify(search.search)}`);
      printResults(node, log, search.id);
    }
    return false;
  }
  node.getResult(target.number);
  return resultAction(command, target, node, log, jobs);
}
async function resultAction(
  command: SelectionCommand,
  target: Target,
  node: BatchNode,
  log: (line: string) => void,
  jobs: Set<string>,
): Promise<boolean> {
  switch (command.name) {
    case "download": {
      const job = await node.downloadResult(
        target.number,
        command.destination,
      );
      jobs.add(job.id);
      log(
        `download ${job.id} ${job.status} path=${JSON.stringify(job.destPath)}`,
      );
      return false;
    }
    case "info":
      printResultInfo(node, target.number, log);
      return false;
    case "magnet":
      printResultMagnet(node, target.number, log);
      return false;
    default:
      throw new Error(`unsupported result action ${command.name}`);
  }
}
function record(outcome: CommandOutcome, result: TargetOutcome): void {
  outcome.targets.push(result);
  if (result.status === "success") outcome.successes++;
  else if (result.status === "noop") outcome.noops++;
  else outcome.failures++;
}
/** Preflight the entire selection before any owner action; runtime failures remain per target. */
export async function executeSelection(
  command: SelectionCommand,
  node: BatchNode,
  log: (line: string) => void,
): Promise<CommandOutcome> {
  const targets = resolveSelector(
    command.selector,
    takeSnapshot(node, command.selector.domain),
  );
  validateDestination(command, targets);
  const outcome = emptyOutcome();
  if (!targets.length) {
    log(
      command.name === "results"
        ? "no searches"
        : `no matching ${command.selector.domain}; no actions taken`,
    );
    return outcome;
  }
  if (command.name === "downloads") {
    const listing = listDownloads(targets, node, log);
    summarize(command, targets.length, listing, log);
    return listing;
  }
  return runBatch(command, targets, node, log);
}
function validateDestination(
  command: SelectionCommand,
  targets: Target[],
): void {
  if (
    command.name === "download" &&
    command.destination !== undefined &&
    targets.length !== 1
  )
    throw new Error("a destination requires exactly one unique result");
}
function listDownloads(
  targets: Target[],
  node: BatchNode,
  log: (line: string) => void,
): CommandOutcome {
  const outcome = emptyOutcome();
  const jobs: ReturnType<BatchNode["getDownloadJobs"]> = [];
  for (const target of targets) {
    try {
      jobs.push(ensureDownload(node, target));
      record(outcome, { target: target.id, status: "success" });
    } catch (error) {
      const reason = errMsg(error);
      record(outcome, { target: target.id, status: "failure", reason });
      log(`${target.id} failed: ${reason}`);
    }
  }
  printDownloads({ getDownloadJobs: () => jobs }, log);
  return outcome;
}
async function runBatch(
  command: SelectionCommand,
  targets: Target[],
  node: BatchNode,
  log: (line: string) => void,
): Promise<CommandOutcome> {
  const outcome = emptyOutcome();
  const existingJobs = new Set(
    command.name === "download"
      ? node.getDownloadJobs().map((j) => j.id)
      : [],
  );
  const jobs = new Set<string>();
  const lines: string[] = [];
  const output =
    command.name === "results" ? (line: string) => lines.push(line) : log;
  for (const target of targets) {
    if (command.name === "results" && lines.length) lines.push("");
    try {
      const noop = await act(command, target, node, output, jobs);
      record(outcome, {
        target: targetLabel(target),
        status: noop ? "noop" : "success",
      });
    } catch (error) {
      const reason = errMsg(error);
      record(outcome, {
        target: targetLabel(target),
        status: "failure",
        reason,
      });
      output(`${targetLabel(target)} failed: ${reason}`);
    }
  }
  outcome.createdJobs = [...jobs].filter((id) => !existingJobs.has(id));
  summarize(command, targets.length, outcome, output);
  if (lines.length) log(lines.join("\n"));
  return outcome;
}
function summarize(
  command: SelectionCommand,
  count: number,
  outcome: CommandOutcome,
  log: (line: string) => void,
): void {
  if (count < 2 && !outcome.failures) return;
  log(
    `${command.name}: ${outcome.successes} succeeded, ${outcome.noops} no-op, ${outcome.failures} failed${command.name === "download" ? `; ${count} input results, ${outcome.createdJobs.length} created jobs` : ""}`,
  );
}
