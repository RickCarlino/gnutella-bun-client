import { RESULT_NAME_WIDTH_MAX } from "./const";
import type { CliNode, ParsedCli } from "./types";

const SIZE_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const RESULT_COUNT_DISPLAY_MAX = 999;
const PEER_TABLE_WIDTH_MAX = 80;

type ResultInfo = ReturnType<CliNode["getResults"]>[number];

function formatSize(bytes: number): string {
  const safeBytes =
    Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${SIZE_FORMAT.format(value)}${SIZE_UNITS[unitIndex]}`;
}

export function displayResultCount(count: number): number {
  const safeCount =
    Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return Math.min(RESULT_COUNT_DISPLAY_MAX, safeCount);
}

export function errMsg(e: any): string {
  return e instanceof Error ? e.message : String(e);
}

function sanitizeTableCell(
  value: string | undefined,
  fallback = "",
): string {
  const safe = (value || "").replace(/[\r\n\t]/g, " ").trim();
  return safe || fallback;
}

function fitTableCell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width, " ");
  if (width <= 2) return value.slice(0, width);
  const kept = width - 2;
  const head = Math.floor(kept / 2);
  const tail = kept - head;
  return `${value.slice(0, head)}..${value.slice(-tail)}`;
}

function peerFlags(peer: ReturnType<CliNode["getPeers"]>[number]): string {
  return `${peer.outbound ? "O" : "I"}${peer.compression ? "Z" : "-"}${peer.tls ? "L" : "-"}`;
}

function valueOrDash(value: string | number | undefined): string {
  return value == null || value === "" ? "-" : String(value);
}

function boolOrDash(value: boolean | undefined): string {
  return value == null ? "-" : String(value);
}

function speedOrDash(speedKBps: number | undefined): string {
  return speedKBps == null ? "-" : `${speedKBps}KB/s`;
}

function appendValueList(
  lines: string[],
  label: string,
  values: string[],
): void {
  if (!values.length) {
    lines.push(`${label}: -`);
    return;
  }
  lines.push(`${label}:`);
  for (const value of values) lines.push(`  ${value}`);
}

function otherUrns(result: ResultInfo): string[] {
  return (result.urns || []).filter((urn) => urn !== result.sha1Urn);
}

function formatResultInfoLines(result: ResultInfo): string[] {
  const lines = [
    `result: #${result.resultNo}`,
    `file: ${JSON.stringify(result.fileName)}`,
    `size: ${formatSize(result.fileSize)} (${result.fileSize}B)`,
    `remote: ${result.remoteHost}:${result.remotePort}`,
    `speed: ${speedOrDash(result.speedKBps)}`,
    `file index: ${valueOrDash(result.fileIndex)}`,
    `servent id: ${result.serventIdHex}`,
    `query id: ${valueOrDash(result.queryIdHex)}`,
    `query hops: ${valueOrDash(result.queryHops)}`,
    `via peer: ${valueOrDash(result.viaPeerKey)}`,
    `sha1 urn: ${valueOrDash(result.sha1Urn)}`,
  ];
  appendValueList(lines, "other urns", otherUrns(result));
  appendValueList(lines, "metadata", result.metadata || []);
  lines.push(`vendor: ${valueOrDash(result.vendorCode)}`);
  lines.push(`needs push: ${boolOrDash(result.needsPush)}`);
  lines.push(`busy: ${boolOrDash(result.busy)}`);
  return lines;
}

export function printStatus(
  node: CliNode,
  log: (msg: string) => void,
): void {
  const status = node.getStatus();
  log(
    `peers=${status.peers} shares=${status.shares} results=${displayResultCount(status.results)} knownPeers=${status.knownPeers}`,
  );
}

export function printPeers(
  node: CliNode,
  log: (msg: string) => void,
): void {
  const peers = node.getPeers();
  if (!peers.length) {
    log("no peers");
    return;
  }
  const rows = peers.map((peer) => ({
    flags: peerFlags(peer),
    remoteLabel: sanitizeTableCell(peer.remoteLabel, "?"),
    userAgent: sanitizeTableCell(peer.userAgent, "-"),
  }));

  const flags = Math.max(
    "FL".length,
    ...rows.map((row) => row.flags.length),
  );
  const desiredRemoteLabel = Math.max(
    "Peer".length,
    ...rows.map((row) => row.remoteLabel.length),
  );
  const desiredUserAgent = Math.max(
    "Agent".length,
    ...rows.map((row) => row.userAgent.length),
  );
  const available = Math.max(
    "Peer".length + "Agent".length,
    PEER_TABLE_WIDTH_MAX - flags - 4,
  );

  let remoteLabel = Math.min(
    desiredRemoteLabel,
    Math.floor(available / 2),
  );
  let userAgent = Math.min(desiredUserAgent, available - remoteLabel);
  let remaining = available - remoteLabel - userAgent;
  if (remaining > 0 && desiredUserAgent > userAgent) {
    const extra = Math.min(remaining, desiredUserAgent - userAgent);
    userAgent += extra;
    remaining -= extra;
  }
  if (remaining > 0 && desiredRemoteLabel > remoteLabel) {
    remoteLabel += Math.min(remaining, desiredRemoteLabel - remoteLabel);
  }

  const widths = {
    flags,
    remoteLabel,
    userAgent,
  };

  const line = (flags: string, remoteLabel: string, userAgent: string) =>
    `${flags.padEnd(widths.flags, " ")}  ${fitTableCell(remoteLabel, widths.remoteLabel)}  ${fitTableCell(userAgent, widths.userAgent)}`.trimEnd();

  log(
    [
      line("FL", "Peer", "Agent"),
      line(
        "-".repeat(widths.flags),
        "-".repeat(widths.remoteLabel),
        "-".repeat(widths.userAgent),
      ),
      ...rows.map((row) =>
        line(row.flags, row.remoteLabel, row.userAgent),
      ),
    ].join("\n"),
  );
}

export function printShares(
  node: CliNode,
  log: (msg: string) => void,
): void {
  const shares = node.getShares();
  if (!shares.length) {
    log("no shared files");
    return;
  }
  for (const f of shares)
    log(`#${f.index} ${f.size}B ${JSON.stringify(f.rel)}`);
}

export function printResults(
  node: CliNode,
  log: (msg: string) => void,
): void {
  const results = node.getResults();
  if (!results.length) {
    log("no results");
    return;
  }
  const rows = [...results]
    .sort(
      (a, b) =>
        a.resultNo - b.resultNo ||
        a.fileName.localeCompare(b.fileName) ||
        a.fileSize - b.fileSize ||
        a.remoteHost.localeCompare(b.remoteHost),
    )
    .map((result) => ({
      resultNo: String(result.resultNo),
      fileName: sanitizeTableCell(result.fileName),
      fileSize: formatSize(result.fileSize),
      remoteHost: result.remoteHost,
    }));

  const widths = {
    resultNo: Math.max(
      "No".length,
      ...rows.map((row) => row.resultNo.length),
    ),
    fileName: RESULT_NAME_WIDTH_MAX,
    fileSize: Math.max(
      "Size".length,
      ...rows.map((row) => row.fileSize.length),
    ),
    remoteHost: Math.max(
      "IP".length,
      ...rows.map((row) => row.remoteHost.length),
    ),
  };

  const line = (
    resultNo: string,
    fileName: string,
    fileSize: string,
    remoteHost: string,
  ) =>
    `${resultNo.padStart(widths.resultNo, " ")}  ${fileName}  ${fileSize.padStart(widths.fileSize, " ")}  ${remoteHost}`.trimEnd();

  const fitName = (fileName: string): string => {
    if (fileName.length <= widths.fileName - 2)
      return fileName.padEnd(widths.fileName, " ");
    if (widths.fileName <= 2) return fileName.slice(0, widths.fileName);
    const kept = widths.fileName - 2;
    const head = Math.floor(kept / 2);
    const tail = kept - head;
    return `${fileName.slice(0, head)}..${fileName.slice(-tail)}`;
  };

  log(
    [
      line("No", "File".padEnd(widths.fileName, " "), "Size", "IP"),
      line(
        "-".repeat(widths.resultNo),
        "-".repeat(widths.fileName),
        "-".repeat(widths.fileSize),
        "-".repeat(widths.remoteHost),
      ),
      ...rows.map((row) =>
        line(
          row.resultNo,
          fitName(row.fileName),
          row.fileSize,
          row.remoteHost,
        ),
      ),
    ].join("\n"),
  );
}

export function printResultInfo(
  node: CliNode,
  resultNo: number,
  log: (msg: string) => void,
): void {
  const result = node
    .getResults()
    .find((candidate) => candidate.resultNo === resultNo);
  if (!result) throw new Error(`no such result ${resultNo}`);
  log(formatResultInfoLines(result).join("\n"));
}

export function parseCli(
  argv: string[],
  defaultConfig: string,
): ParsedCli {
  let config = defaultConfig;
  const exec: string[] = [];
  let command = "run";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") config = argv[++i] || config;
    else if (a === "--exec") exec.push(argv[++i] || "");
    else if (!a.startsWith("-") && command === "run") command = a;
  }
  return { config, exec, command };
}

export function runExecCommands(
  execCmds: string[],
  log: (msg: string) => void,
  sleep: (ms: number) => Promise<void>,
  runCommand: (line: string) => Promise<boolean>,
  errMsg: (e: any) => string,
): void {
  if (!execCmds.length) return;
  void (async () => {
    await sleep(500);
    for (const cmd of execCmds) {
      log(`exec> ${cmd}`);
      try {
        const keep = await runCommand(cmd);
        if (!keep) return;
      } catch (e) {
        log(`command failed: ${errMsg(e)}`);
      }
    }
  })();
}
