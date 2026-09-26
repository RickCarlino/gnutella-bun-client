import {
  executeCommand,
  type CommandNode,
  type ExecutionContext,
} from "../../src/cli/execute";
import { parseCommand } from "../../src/cli/parse";
import { CommandError } from "../../src/cli/tokens";
import type { MonitorMode } from "../../src/cli_monitor";
import { sleep } from "../../src/shared";

export function executionContext(
  node: CommandNode,
  log: (line: string) => void = () => {},
): ExecutionContext {
  let mode: MonitorMode = "off";
  return {
    node,
    log,
    sleep,
    shutdown: async () => {},
    monitor: {
      get: () => mode,
      set: (value) => {
        mode = value;
      },
    },
  };
}
export async function executeLine(
  context: ExecutionContext,
  line: string,
) {
  const parsed = parseCommand(line);
  if (!parsed.ok) throw new CommandError(parsed.diagnostic);
  if (!parsed.command) throw new Error("expected a command");
  return executeCommand(parsed.command, context);
}
