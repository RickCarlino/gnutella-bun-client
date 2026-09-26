import { CommandError, type Span, type Token } from "./tokens";

export type Domain = "results" | "downloads" | "searches";
const DOWNLOAD_STATUSES = [
  "queued",
  "active",
  "paused",
  "verifying",
  "complete",
  "failed",
  "verification_failed",
] as const;
const SEARCH_STATUSES = ["active", "complete", "failed"] as const;
export type SelectorItem =
  | { kind: "reference"; value: string; number?: number; span: Span }
  | { kind: "range"; first: number; last: number; span: Span }
  | { kind: "keyword"; value: string; span: Span };
export type Selector = { domain: Domain; items: SelectorItem[] };
export function keywords(domain: Domain, all = true): readonly string[] {
  const statuses =
    domain === "results"
      ? []
      : domain === "downloads"
        ? DOWNLOAD_STATUSES
        : SEARCH_STATUSES;
  return all && domain !== "results" ? [...statuses, "all"] : statuses;
}
function fail(message: string, span: Span, suggestion?: string): never {
  throw new CommandError({ message, span, suggestion, usage: "" });
}
function numericReference(
  value: string,
  domain: Domain,
): number | undefined {
  const prefix =
    domain === "results" ? "" : domain === "downloads" ? "d" : "q";
  if (!new RegExp(`^${prefix}[1-9]\\d*$`, "i").test(value))
    return undefined;
  const number = Number(value.slice(prefix.length));
  return Number.isSafeInteger(number) ? number : undefined;
}
/** Full IDs retain exact, case-sensitive owner matching. */
function isSearchId(value: string): boolean {
  return /^[a-f\d]{32}$/i.test(value);
}
export function inferDomain(value: string, allowResults = false): Domain {
  const first = value.trim().split(/[\s,]/)[0];
  if (
    isSearchId(first) ||
    (/^q/i.test(first) &&
      !keywords("downloads").includes(first.toLowerCase()))
  )
    return "searches";
  if (allowResults && /^[0-9]/.test(first)) return "results";
  return "downloads";
}
function parseItem(
  value: string,
  domain: Domain,
  allowed: readonly string[],
  span: Span,
): SelectorItem {
  const lower = value.toLowerCase();
  if (allowed.includes(lower))
    return { kind: "keyword", value: lower, span };
  const number = numericReference(value, domain);
  if (number !== undefined)
    return { kind: "reference", value: lower, number, span };
  if (domain === "searches" && isSearchId(value))
    return { kind: "reference", value, span };
  if (value.includes("-")) return parseRange(value, domain, span);
  const suggestion = allowed.find(
    (word) => editDistance(lower, word) <= 2,
  );
  return fail(
    `invalid ${domain} selector ${JSON.stringify(value)}`,
    span,
    suggestion,
  );
}
function parseRange(
  value: string,
  domain: Domain,
  span: Span,
): SelectorItem {
  const parts = value.split(/\s*-\s*/);
  const first = numericReference(parts[0], domain);
  const last = numericReference(parts[1] || "", domain);
  if (
    parts.length !== 2 ||
    first === undefined ||
    last === undefined ||
    first > last
  )
    return fail(
      `invalid ascending ${domain} range ${JSON.stringify(value)}`,
      span,
    );
  return { kind: "range", first, last, span };
}
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(
          next[j] + 1,
          row[j + 1] + 1,
          row[j] + Number(a[i] !== b[j]),
        ),
      );
    row = next;
  }
  return row[b.length];
}
/** Consume only punctuation-connected tokens; whitespace alone ends the selector. */
export function selectorTokens(tokens: Token[]): {
  value: string;
  offsets: number[];
  rest: Token[];
  span: Span;
} {
  const selected: Token[] = [];
  for (const token of tokens) {
    const previous = selected.at(-1);
    if (previous && !connectedTokens(previous, token)) break;
    selected.push(token);
  }
  return {
    value: selected.map((t) => t.value).join(" "),
    offsets: selected.flatMap((t, i) =>
      i ? [t.start, ...t.offsets] : t.offsets,
    ),
    rest: tokens.slice(selected.length),
    span: {
      start: selected[0]?.start ?? 0,
      end: selected.at(-1)?.end ?? 0,
    },
  };
}
export function parseSelector(
  input: ReturnType<typeof selectorTokens>,
  domain: Domain,
  all = true,
): Selector {
  let offset = 0;
  const items = input.value.split(",").map((part) => {
    const leading = part.length - part.trimStart().length;
    const start = input.offsets[offset + leading] ?? input.span.end;
    const end =
      (input.offsets[offset + part.trimEnd().length - 1] ?? start - 1) + 1;
    offset += part.length + 1;
    return parseItem(part.trim(), domain, keywords(domain, all), {
      start,
      end,
    });
  });
  return { domain, items };
}
export function allSelector(domain: Domain): Selector {
  return {
    domain,
    items: [{ kind: "keyword", value: "all", span: { start: 0, end: 0 } }],
  };
}

function connectedTokens(previous: Token, token: Token): boolean {
  return (
    !previous.quoted &&
    !token.quoted &&
    (/[,-]\s*$/.test(previous.value) || /^\s*[,-]/.test(token.value))
  );
}
