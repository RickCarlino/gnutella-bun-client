export type Span = { start: number; end: number };
export type CommandDiagnostic = {
  message: string;
  span: Span;
  usage: string;
  suggestion?: string;
};
export class CommandError extends Error {
  constructor(readonly diagnostic: CommandDiagnostic) {
    super(
      `${diagnostic.message}${diagnostic.suggestion ? `; did you mean ${diagnostic.suggestion}?` : ""}${diagnostic.usage ? `; usage: ${diagnostic.usage}` : ""}`,
    );
  }
}
export type Token = Span & {
  value: string;
  offsets: number[];
  quoted: boolean;
  quote: string;
  escaped: boolean;
};

/** One scanner for submitted commands and incomplete editing. Offsets map decoded characters to source. */
export function scan(line: string, tolerant = false): Token[] {
  const tokens: Token[] = [];
  let token: Token | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!token && /\s/.test(ch)) continue;
    token ??= {
      start: i,
      end: i,
      value: "",
      offsets: [],
      quoted: false,
      quote: "",
      escaped: false,
    };
    if (!consume(token, ch, i)) {
      tokens.push(token);
      token = undefined;
    }
  }
  if (token) {
    checkIncomplete(token, tolerant, line.length);
    tokens.push(token);
  }
  return tokens;
}
function append(token: Token, ch: string, offset: number): void {
  token.value += ch;
  token.offsets.push(offset);
}
function consume(token: Token, ch: string, offset: number): boolean {
  if (token.escaped) {
    append(token, ch, offset);
    token.escaped = false;
  } else if (ch === "\\") token.escaped = true;
  else if (token.quote) {
    if (ch === token.quote) token.quote = "";
    else append(token, ch, offset);
  } else if (ch === '"' || ch === "'") {
    token.quote = ch;
    token.quoted = true;
  } else if (/\s/.test(ch)) return false;
  else append(token, ch, offset);
  token.end = offset + 1;
  return true;
}

function checkIncomplete(
  token: Token,
  tolerant: boolean,
  end: number,
): void {
  if (tolerant || (!token.quote && !token.escaped)) return;
  throw new CommandError({
    message: token.escaped ? "dangling escape" : "unfinished quote",
    span: { start: token.start, end },
    usage: "",
  });
}
