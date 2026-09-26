import type { GnutellaServent } from "../servent";
import { COMMANDS, findCommand, type CommandDefinition } from "./commands";
import { takeSnapshot, type Target } from "./resolve";
import {
  inferDomain,
  keywords,
  parseSelector,
  selectorTokens,
  type Domain,
  type Selector,
} from "./selectors";
import { scan, type Span, type Token } from "./tokens";

export type CompletionContext = {
  targets: readonly Target[];
  peers: readonly string[];
  blocked: readonly string[];
};
type Completion = { candidates: string[]; span: Span };
export function completionContext(
  node: Pick<
    GnutellaServent,
    | "getSearches"
    | "getResults"
    | "getDownloadJobs"
    | "getPeers"
    | "getBlockedIps"
  >,
): CompletionContext {
  return {
    targets: [
      ...takeSnapshot(node, "results"),
      ...takeSnapshot(node, "searches"),
      ...takeSnapshot(node, "downloads"),
    ],
    peers: node.getPeers().map((p) => p.key),
    blocked: node.getBlockedIps(),
  };
}
function label(target: Target): string {
  if (target.domain === "results") return String(target.number);
  return `${target.domain === "searches" ? "q" : "d"}${target.number}`;
}
function choices(
  definition: CommandDefinition,
  domains: Domain[],
  context: CompletionContext,
): string[] {
  return [
    ...domains.flatMap((domain) =>
      keywords(domain, definition.name !== "info"),
    ),
    ...context.targets
      .filter((t) => domains.includes(t.domain))
      .map(label),
  ];
}
function finish(
  values: string[],
  prefix: string,
  start: number,
  line: string,
  cursor: number,
  quote = "",
): Completion {
  const suffix = /^[\w]*/.exec(line.slice(cursor))?.[0] ?? "";
  const candidates = [...new Set(values)]
    .filter(
      (v) =>
        v.toLowerCase().startsWith(prefix.toLowerCase()) &&
        v.endsWith(suffix),
    )
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((v) => v.slice(0, v.length - suffix.length) + quote);
  return { candidates, span: { start, end: cursor } };
}
function argumentChoices(
  definition: CommandDefinition,
  context: CompletionContext,
): string[] {
  if (definition.form === "monitor")
    return ["on", "off", "all", "downloads"];
  if (definition.name === "browse") return [...context.peers];
  if (definition.name === "unblock") return [...context.blocked];
  return [];
}
function completedQuote(
  token: Token | undefined,
  line: string,
  cursor: number,
): string {
  if (token?.quoted && !token.quote && /['"]/.test(line[cursor - 1] ?? ""))
    return line[cursor - 1];
  return "";
}
function argumentCompletion(
  definition: CommandDefinition,
  args: Token[],
  context: CompletionContext,
  line: string,
  cursor: number,
): Completion {
  const last = args.at(-1);
  const blank = !last || last.end < cursor;
  const none = { candidates: [], span: { start: cursor, end: cursor } };
  if (args.length > 1 || (blank && args.length > 0)) return none;
  return finish(
    argumentChoices(definition, context),
    last?.value ?? "",
    last?.offsets[0] ?? cursor - completedQuote(last, line, cursor).length,
    line,
    cursor,
    completedQuote(last, line, cursor),
  );
}
function rangeChoices(
  member: string,
  values: string[],
  context: CompletionContext,
): string[] {
  const range = /^([dq]?)([1-9]\d*)\s*-\s*/i.exec(member);
  if (!range) return values;
  const domain: Domain =
    range[1].toLowerCase() === "d"
      ? "downloads"
      : range[1].toLowerCase() === "q"
        ? "searches"
        : "results";
  return context.targets
    .filter((t) => t.domain === domain && t.number >= Number(range[2]))
    .map(label)
    .filter((v) => values.includes(v));
}
function excludeEarlier(
  values: string[],
  earlier: string,
  domains: Domain[],
): string[] {
  const explicit = earlier.split(",").map((s) => s.trim().toLowerCase());
  const selectors: Selector[] = [];
  for (const domain of domains) {
    try {
      selectors.push(parseSelector(selectorTokens(scan(earlier)), domain));
    } catch {
      /* Incomplete earlier members are normal while editing. */
    }
  }
  return values.filter(
    (value) =>
      !explicit.includes(value.toLowerCase()) &&
      !selectors.some((selector) => selectedNumber(value, selector)),
  );
}
function selectedNumber(value: string, selector: Selector): boolean {
  const prefix =
    selector.domain === "results"
      ? ""
      : selector.domain === "downloads"
        ? "d"
        : "q";
  if (!value.startsWith(prefix)) return false;
  const digits = value.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(digits)) return false;
  const number = Number(digits);
  return selector.items.some((item) =>
    item.kind === "range"
      ? number >= item.first && number <= item.last
      : item.kind === "reference" && item.number === number,
  );
}

function selectorCompletion(
  definition: CommandDefinition,
  args: Token[],
  context: CompletionContext,
  line: string,
  cursor: number,
): Completion {
  let domains = definition.domains;
  let explicitDomain = false;
  const domain = clearDomain(definition, args, cursor);
  if (domain) {
    domains = [domain];
    args = args.slice(1);
    explicitDomain = true;
  }
  const input = selectorTokens(args);
  const last = args.at(-1);
  if (
    input.rest.length ||
    (last && last.end < cursor && !/[,\-]\s*$/.test(input.value))
  )
    return { candidates: [], span: { start: cursor, end: cursor } };
  return memberCompletion(
    definition,
    domains,
    explicitDomain,
    input,
    last,
    context,
    line,
    cursor,
  );
}
function memberCompletion(
  definition: CommandDefinition,
  domains: Domain[],
  explicitDomain: boolean,
  input: ReturnType<typeof selectorTokens>,
  last: Token | undefined,
  context: CompletionContext,
  line: string,
  cursor: number,
): Completion {
  const comma = input.value.lastIndexOf(",");
  const member = input.value.slice(comma + 1);
  const range = /^\s*[dq]?[1-9]\d*\s*-\s*/i.exec(member);
  const prefix = (
    range ? member.slice(range[0].length) : member
  ).trimStart();
  const offset = input.value.length - prefix.length;
  const start =
    input.offsets[offset] ??
    cursor - completedQuote(last, line, cursor).length;
  if (comma >= 0 && domains.length > 1)
    domains = [inferDomain(input.value, definition.name === "info")];
  let values = selectorChoices(
    definition,
    domains,
    explicitDomain,
    comma,
    context,
  );
  values = rangeChoices(member.trimStart(), values, context);
  values = excludeEarlier(
    values,
    comma < 0 ? "" : input.value.slice(0, comma),
    domains,
  );
  return finish(
    values,
    prefix,
    start,
    line,
    cursor,
    completedQuote(last, line, cursor),
  );
}
/** Replacement spans cover only text before the cursor; compatible suffixes remain untouched. */
export function complete(
  line: string,
  cursor: number,
  context: CompletionContext,
): Completion {
  const tokens = scan(line.slice(0, cursor), true);
  const first = tokens[0];
  if (!first || (tokens.length === 1 && first.end === cursor)) {
    return commandCompletion(first, line, cursor);
  }
  const definition = findCommand(first.value);
  if (!definition)
    return { candidates: [], span: { start: cursor, end: cursor } };
  if (definition.form === "selector")
    return selectorCompletion(
      definition,
      tokens.slice(1),
      context,
      line,
      cursor,
    );
  return argumentCompletion(
    definition,
    tokens.slice(1),
    context,
    line,
    cursor,
  );
}
/** node:readline replaces a suffix of its supplied prefix, preserving the text after the cursor. */
export function readlineCompletion(
  prefix: string,
  line: string,
  context: CompletionContext,
): [string[], string] {
  const result = complete(line, prefix.length, context);
  return [result.candidates, prefix.slice(result.span.start)];
}

function commandCompletion(
  first: Token | undefined,
  line: string,
  cursor: number,
): Completion {
  return finish(
    COMMANDS.flatMap((c) => [c.name, ...c.aliases]),
    first?.value ?? "",
    first?.offsets[0] ??
      cursor - completedQuote(first, line, cursor).length,
    line,
    cursor,
    completedQuote(first, line, cursor),
  );
}

function selectorChoices(
  definition: CommandDefinition,
  domains: Domain[],
  explicitDomain: boolean,
  comma: number,
  context: CompletionContext,
): string[] {
  const values = choices(definition, domains, context);
  if (definition.name !== "clear" || explicitDomain) return values;
  return [
    ...values.filter((v) => v !== "all"),
    ...(comma < 0 ? ["searches", "downloads"] : []),
  ];
}

function clearDomain(
  definition: CommandDefinition,
  args: Token[],
  cursor: number,
): Domain | undefined {
  const first = args[0];
  if (definition.name !== "clear" || !first || first.end === cursor)
    return;
  const domain = first.value.toLowerCase();
  if (domain === "searches" || domain === "downloads") return domain;
}
