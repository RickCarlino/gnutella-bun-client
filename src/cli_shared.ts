import { errMsg } from "./shared";
import type { CliNode, ParsedCli } from "./types";
import { buildMagnetUri } from "./protocol/magnet";
import type { DownloadJob } from "./downloads";

const SIZE_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: false,
});
const SIZE_UNITS = ["b", "kb", "mb", "gb", "tb", "pb"];
const SIZE_VALUE_WIDTH = 5;
const SIZE_UNIT_WIDTH = 2;
const RESULT_COUNT_DISPLAY_MAX = 999;
const PEER_TABLE_WIDTH_MAX = 80;

type ResultInfo = ReturnType<CliNode["getResults"]>[number];
type DownloadCliNode = CliNode & {
  getDownloadJobs(): DownloadJob[];
};
type FormattedSize = { value: string; unit: string };

function formattedSize(bytes: number): FormattedSize {
  const safeBytes =
    Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return {
    value: unitIndex === 0 ? String(value) : SIZE_FORMAT.format(value),
    unit: SIZE_UNITS[unitIndex],
  };
}

function formatSize(bytes: number): string {
  const size = formattedSize(bytes);
  return `${size.value} ${size.unit}`;
}

function formatResultSize(bytes: number): string {
  const size = formattedSize(bytes);
  return `${size.value.padStart(SIZE_VALUE_WIDTH, " ")} ${size.unit.padEnd(SIZE_UNIT_WIDTH, " ")}`;
}

export function displayResultCount(count: number): number {
  const safeCount =
    Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return Math.min(RESULT_COUNT_DISPLAY_MAX, safeCount);
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
  return `${peer.outbound ? "O" : "I"}${peer.compression ? "Z" : "-"}${peer.tls ? "L" : "-"}${peer.role === "ultrapeer" ? "U" : "-"}`;
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

function resultMagnetUri(result: ResultInfo): string {
  return buildMagnetUri({
    fileName: result.fileName,
    fileSize: result.fileSize,
    urns: result.urns,
    sha1Urn: result.sha1Urn,
  });
}

function findResult(node: CliNode, resultNo: number): ResultInfo {
  const result = node
    .getResults()
    .find((candidate) => candidate.resultNo === resultNo);
  if (!result) throw new Error(`no such result ${resultNo}`);
  return result;
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
    key: sanitizeTableCell(peer.key, "?"),
    flags: peerFlags(peer),
    remoteLabel: sanitizeTableCell(peer.remoteLabel, "?"),
    userAgent: sanitizeTableCell(peer.userAgent, "-"),
  }));

  const key = Math.max("Id".length, ...rows.map((row) => row.key.length));
  const flags = Math.max(
    "Flags".length,
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
    PEER_TABLE_WIDTH_MAX - key - flags - 6,
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
    key,
    flags,
    remoteLabel,
    userAgent,
  };

  const line = (
    key: string,
    flags: string,
    remoteLabel: string,
    userAgent: string,
  ) =>
    `${key.padEnd(widths.key, " ")}  ${flags.padEnd(widths.flags, " ")}  ${fitTableCell(remoteLabel, widths.remoteLabel)}  ${fitTableCell(userAgent, widths.userAgent)}`.trimEnd();

  log(
    [
      line("Id", "Flags", "Peer", "Agent"),
      line(
        "-".repeat(widths.key),
        "-".repeat(widths.flags),
        "-".repeat(widths.remoteLabel),
        "-".repeat(widths.userAgent),
      ),
      ...rows.map((row) =>
        line(row.key, row.flags, row.remoteLabel, row.userAgent),
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
        a.resultNo - b.resultNo || a.fileName.localeCompare(b.fileName),
    )
    .map((result) => ({
      resultNo: String(result.resultNo),
      fileSize: formatResultSize(result.fileSize),
      fileName: sanitizeTableCell(result.fileName),
    }));

  const widths = {
    resultNo: Math.max(
      "No".length,
      ...rows.map((row) => row.resultNo.length),
    ),
    fileSize: Math.max(
      "Size".length,
      ...rows.map((row) => row.fileSize.length),
    ),
    fileName: Math.max(
      "File".length,
      ...rows.map((row) => row.fileName.length),
    ),
  };

  const line = (resultNo: string, fileSize: string, fileName: string) =>
    `${resultNo.padStart(widths.resultNo, " ")}  ${fileSize.padStart(widths.fileSize, " ")}  ${fileName.padEnd(widths.fileName, " ")}`.trimEnd();

  log(
    [
      line("No", "Size", "File"),
      line(
        "-".repeat(widths.resultNo),
        "-".repeat(widths.fileSize),
        "-".repeat(widths.fileName),
      ),
      ...rows.map((row) => line(row.resultNo, row.fileSize, row.fileName)),
    ].join("\n"),
  );
}

function downloadProgress(job: DownloadJob): string {
  if (job.fileSize <= 0) return `${job.bytesCompleted}B`;
  const percent = Math.min(
    100,
    Math.floor((job.bytesCompleted / job.fileSize) * 100),
  );
  return `${percent}%`;
}

export function printDownloads(
  node: DownloadCliNode,
  log: (msg: string) => void,
): void {
  const jobs = node.getDownloadJobs();
  if (!jobs.length) {
    log("no downloads");
    return;
  }
  const rows = jobs.map((job) => ({
    id: sanitizeTableCell(job.id),
    status: sanitizeTableCell(job.status),
    progress: downloadProgress(job),
    size: formatResultSize(job.fileSize),
    fileName: sanitizeTableCell(job.fileName),
  }));
  const widths = {
    id: Math.max("Id".length, ...rows.map((row) => row.id.length)),
    status: Math.max(
      "Status".length,
      ...rows.map((row) => row.status.length),
    ),
    progress: Math.max(
      "Done".length,
      ...rows.map((row) => row.progress.length),
    ),
    size: Math.max("Size".length, ...rows.map((row) => row.size.length)),
    fileName: Math.max(
      "File".length,
      ...rows.map((row) => row.fileName.length),
    ),
  };
  const line = (
    id: string,
    status: string,
    progress: string,
    size: string,
    fileName: string,
  ) =>
    `${id.padEnd(widths.id, " ")}  ${status.padEnd(widths.status, " ")}  ${progress.padStart(widths.progress, " ")}  ${size.padStart(widths.size, " ")}  ${fileName.padEnd(widths.fileName, " ")}`.trimEnd();
  log(
    [
      line("Id", "Status", "Done", "Size", "File"),
      line(
        "-".repeat(widths.id),
        "-".repeat(widths.status),
        "-".repeat(widths.progress),
        "-".repeat(widths.size),
        "-".repeat(widths.fileName),
      ),
      ...rows.map((row) =>
        line(row.id, row.status, row.progress, row.size, row.fileName),
      ),
    ].join("\n"),
  );
}

export function printResultInfo(
  node: CliNode,
  resultNo: number,
  log: (msg: string) => void,
): void {
  const result = findResult(node, resultNo);
  log(formatResultInfoLines(result).join("\n"));
}

export function printResultMagnet(
  node: CliNode,
  resultNo: number,
  log: (msg: string) => void,
): void {
  log(resultMagnetUri(findResult(node, resultNo)));
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
  formatError: (e: unknown) => string,
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
        log(`command failed: ${formatError(e)}`);
      }
    }
  })();
}

export { errMsg };
