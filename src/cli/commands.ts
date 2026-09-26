import {
  allSelector,
  inferDomain,
  parseSelector,
  selectorTokens,
  type Domain,
  type Selector,
} from "./selectors";
import { CommandError, type Token } from "./tokens";

export type ParsedCommand =
  | {
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
  | { name: "query"; text: string }
  | { name: "browse" | "connect" | "block" | "unblock"; address: string }
  | { name: "ping"; ttl?: number }
  | { name: "sleep"; seconds: number }
  | { name: "monitor"; mode?: "on" | "off" | "all" | "downloads" }
  | { name: "download"; selector: Selector; destination?: string }
  | {
      name:
        | "pause"
        | "resume"
        | "remove"
        | "clear"
        | "results"
        | "downloads"
        | "info"
        | "magnet";
      selector: Selector;
    };
export type CommandDefinition = {
  name: ParsedCommand["name"];
  aliases: string[];
  usage: string;
  description: string;
  form: "none" | "selector" | "text" | "address" | "number" | "monitor";
  domains: Domain[];
  parse: (args: Token[]) => ParsedCommand;
};
function invalid(args: Token[], message = "invalid arguments"): never {
  throw new CommandError({
    message,
    span: { start: args[0]?.start ?? 0, end: args.at(-1)?.end ?? 0 },
    usage: "",
  });
}
function count(args: Token[], min: number, max = min): void {
  if (args.length < min) invalid(args);
  if (args.length > max) invalid(args.slice(max), "surplus arguments");
}
function noArgs(
  name: Extract<
    ParsedCommand,
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
  >["name"],
): (args: Token[]) => ParsedCommand {
  return (args) => {
    count(args, 0);
    return { name };
  };
}
function address(
  name: "browse" | "connect" | "block" | "unblock",
): (args: Token[]) => ParsedCommand {
  return (args) => {
    count(args, 1);
    if (!args[0].value) invalid(args);
    return {
      name,
      address:
        name === "browse" && /^p[1-9]\d*$/i.test(args[0].value)
          ? args[0].value.toLowerCase()
          : args[0].value,
    };
  };
}
function selection(
  name: "pause" | "resume" | "remove" | "results" | "downloads" | "magnet",
  domain: Domain,
  optional = false,
): (args: Token[]) => ParsedCommand {
  return (args) => {
    if (!args.length && optional)
      return { name, selector: allSelector(domain) };
    count(args, 1, Infinity);
    const input = selectorTokens(args);
    count(input.rest, 0);
    return { name, selector: parseSelector(input, domain) };
  };
}
function parseClear(args: Token[]): ParsedCommand {
  if (!args.length)
    return { name: "clear", selector: allSelector("searches") };
  const explicit = args[0].value.toLowerCase();
  const domain =
    explicit === "downloads" || explicit === "searches"
      ? explicit
      : undefined;
  const input = selectorTokens(domain ? args.slice(1) : args);
  if (
    !domain &&
    input.value
      .toLowerCase()
      .split(",")
      .some((v) => v.trim() === "all")
  )
    invalid(
      args,
      "clear all is ambiguous; use clear searches all or clear downloads all",
    );
  count(input.rest, 0);
  return {
    name: "clear",
    selector: parseSelector(input, domain ?? inferDomain(input.value)),
  };
}
function parseInfo(args: Token[]): ParsedCommand {
  count(args, 1, Infinity);
  const input = selectorTokens(args);
  count(input.rest, 0);
  const domain = inferDomain(input.value, true);
  if (domain === "searches")
    invalid(args, "info expects results or downloads");
  return { name: "info", selector: parseSelector(input, domain, false) };
}
function parseDownload(args: Token[]): ParsedCommand {
  count(args, 1, Infinity);
  const input = selectorTokens(args);
  count(input.rest, 0, 1);
  const destination = input.rest[0]?.value;
  if (destination === "")
    invalid(input.rest, "destination cannot be empty");
  return {
    name: "download",
    selector: parseSelector(input, "results"),
    destination,
  };
}
function parseMonitor(args: Token[]): ParsedCommand {
  count(args, 0, 1);
  const mode = args[0]?.value.toLowerCase();
  if (
    mode === undefined ||
    mode === "on" ||
    mode === "off" ||
    mode === "all" ||
    mode === "downloads"
  )
    return { name: "monitor", mode };
  return invalid(args, "invalid monitor mode");
}
function parsePing(args: Token[]): ParsedCommand {
  count(args, 0, 1);
  if (!args.length) return { name: "ping" };
  const ttl = Number(args[0].value);
  if (!/^[1-9]\d*$/.test(args[0].value) || ttl > 255)
    invalid(args, "TTL must be an integer from 1 to 255");
  return { name: "ping", ttl };
}
function parseSleep(args: Token[]): ParsedCommand {
  count(args, 0, 1);
  const value = args[0]?.value ?? "0";
  const seconds = Number(value);
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
    !Number.isFinite(seconds) ||
    seconds * 1000 > 2147483647
  )
    invalid(
      args,
      "sleep expects nonnegative seconds (at most 2147483.647)",
    );
  return { name: "sleep", seconds };
}
function definition(
  name: ParsedCommand["name"],
  usage: string,
  description: string,
  form: CommandDefinition["form"],
  parse: CommandDefinition["parse"],
  domains: Domain[] = [],
  aliases: string[] = [],
): CommandDefinition {
  return { name, usage, description, form, parse, domains, aliases };
}
export const COMMANDS: CommandDefinition[] = [
  definition(
    "help",
    "help",
    "Show commands and selector rules.",
    "none",
    noArgs("help"),
  ),
  definition(
    "status",
    "status",
    "Show current status.",
    "none",
    noArgs("status"),
  ),
  definition(
    "peers",
    "peers",
    "List connected peers.",
    "none",
    noArgs("peers"),
  ),
  definition(
    "blocked",
    "blocked",
    "List blocked IPs.",
    "none",
    noArgs("blocked"),
  ),
  definition(
    "shares",
    "shares",
    "List shared files.",
    "none",
    noArgs("shares"),
  ),
  definition(
    "queries",
    "queries",
    "List searches.",
    "none",
    noArgs("queries"),
  ),
  definition(
    "rescan",
    "rescan",
    "Refresh shared files.",
    "none",
    noArgs("rescan"),
  ),
  definition(
    "save",
    "save",
    "Save configuration.",
    "none",
    noArgs("save"),
  ),
  definition(
    "quit",
    "quit",
    "Shut down and discard pending commands.",
    "none",
    noArgs("quit"),
    [],
    ["exit"],
  ),
  definition(
    "query",
    "query <search terms...>",
    "Start a search.",
    "text",
    (args) => {
      const text = args.map((t) => t.value).join(" ");
      if (!text.trim()) invalid(args);
      return { name: "query", text };
    },
    [],
    ["search"],
  ),
  definition(
    "browse",
    "browse <peerKey|ip:port>",
    "Browse a peer.",
    "address",
    address("browse"),
  ),
  definition(
    "connect",
    "connect <ip:port>",
    "Connect and remember a peer.",
    "address",
    address("connect"),
  ),
  definition(
    "block",
    "block <ipv4>",
    "Block an IP.",
    "address",
    address("block"),
  ),
  definition(
    "unblock",
    "unblock <ipv4>",
    "Unblock an IP.",
    "address",
    address("unblock"),
  ),
  definition(
    "ping",
    "ping [ttl]",
    "Ping with TTL 1–255.",
    "number",
    parsePing,
  ),
  definition(
    "sleep",
    "sleep [seconds]",
    "Wait; fractional seconds are allowed.",
    "number",
    parseSleep,
  ),
  definition(
    "monitor",
    "monitor [on|off|all|downloads]",
    "Toggle or select live logging.",
    "monitor",
    parseMonitor,
  ),
  definition(
    "download",
    "download <selector> [destPath]",
    "Queue results; a destination requires one unique result.",
    "selector",
    parseDownload,
    ["results"],
  ),
  definition(
    "pause",
    "pause <selector>",
    "Pause downloads.",
    "selector",
    selection("pause", "downloads"),
    ["downloads"],
  ),
  definition(
    "resume",
    "resume <selector>",
    "Resume downloads.",
    "selector",
    selection("resume", "downloads"),
    ["downloads"],
  ),
  definition(
    "remove",
    "remove <selector>",
    "Forget downloads; delete incomplete files, preserve completed files.",
    "selector",
    selection("remove", "downloads"),
    ["downloads"],
  ),
  definition(
    "clear",
    "clear [searches|downloads] [selector]",
    "Bare clear clears searches. Statuses mean downloads; download clearing is remove.",
    "selector",
    parseClear,
    ["searches", "downloads"],
  ),
  definition(
    "results",
    "results [selector]",
    "Show selected searches; defaults to all.",
    "selector",
    selection("results", "searches", true),
    ["searches"],
  ),
  definition(
    "downloads",
    "downloads [selector]",
    "Show selected downloads; defaults to all.",
    "selector",
    selection("downloads", "downloads", true),
    ["downloads"],
  ),
  definition(
    "info",
    "info <selector>",
    "Inspect results or downloads; all is ambiguous and unavailable.",
    "selector",
    parseInfo,
    ["results", "downloads"],
  ),
  definition(
    "magnet",
    "magnet <selector>",
    "Print result magnet links.",
    "selector",
    selection("magnet", "results"),
    ["results"],
  ),
];
export function findCommand(name: string): CommandDefinition | undefined {
  return COMMANDS.find(
    (command) =>
      command.name === name.toLowerCase() ||
      command.aliases.includes(name.toLowerCase()),
  );
}
export function commandHelp(): string {
  return [
    ...COMMANDS.map(
      (c) =>
        `${c.usage}${c.aliases.length ? ` (${c.aliases.join(", ")})` : ""}\n  ${c.description}`,
    ),
    "Selectors: 3,4,7 or 3-7,12; d10-d20; q1-q3,q7. Commas form unions; whitespace alone does not.",
    "Download statuses: queued, active, paused, verifying, complete, failed, verification_failed (exact matches).",
    "Search statuses: active, complete, failed. Full search IDs are single list items, never range endpoints.",
    "Use all for a declared domain; clear all is ambiguous: use clear downloads all or clear searches all.",
    "Ranges skip missing IDs; empty ranges/statuses are no-ops. Missing explicit IDs reject the whole command.",
    "Ranges/keywords expand in numeric order; unions preserve item order and deduplicate targets.",
    "Download clearing deletes incomplete files and preserves completed files. Bare clear only clears searches.",
  ].join("\n");
}
