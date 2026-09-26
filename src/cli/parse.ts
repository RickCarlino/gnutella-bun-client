import { findCommand, type ParsedCommand } from "./commands";
import { CommandError, scan, type CommandDiagnostic } from "./tokens";

type ParseResult =
  | { ok: true; command: ParsedCommand | null }
  | { ok: false; diagnostic: CommandDiagnostic };
/** Parse a complete line without accessing live state. */
export function parseCommand(line: string): ParseResult {
  let usage = "";
  try {
    const tokens = scan(line);
    if (!tokens.length) return { ok: true, command: null };
    const definition = findCommand(tokens[0].value);
    if (!definition)
      throw new CommandError({
        message: `unknown command: ${tokens[0].value}`,
        span: tokens[0],
        usage: "help",
      });
    usage = definition.usage;
    return { ok: true, command: definition.parse(tokens.slice(1)) };
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    return {
      ok: false,
      diagnostic: completeDiagnostic(error.diagnostic, usage, line),
    };
  }
}

function diagnosticSpan(diagnostic: CommandDiagnostic, end: number) {
  if (diagnostic.span.start === 0 && diagnostic.span.end === 0)
    return { start: end, end };
  return diagnostic.span;
}

function completeDiagnostic(
  diagnostic: CommandDiagnostic,
  usage: string,
  line: string,
): CommandDiagnostic {
  return {
    ...diagnostic,
    usage:
      diagnostic.usage ||
      usage ||
      findCommand(scan(line, true)[0]?.value ?? "")?.usage ||
      "help",
    span: diagnosticSpan(diagnostic, line.length),
  };
}
