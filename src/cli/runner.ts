import { errMsg } from "../shared";
import { emptyOutcome, type CommandOutcome } from "./batch";
import { executeCommand, type ExecutionContext } from "./execute";
import { parseCommand } from "./parse";
import { CommandError } from "./tokens";

/** Both entry points submit to this queue. Stop discards work that has not begun. */
export class CommandRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly context: ExecutionContext) {}
  stop(): void {
    this.stopped = true;
  }
  submit(line: string): Promise<CommandOutcome> {
    const next = this.tail.then(() => this.run(line));
    this.tail = next;
    return next;
  }
  private async run(line: string): Promise<CommandOutcome> {
    if (this.stopped) return emptyOutcome(false);
    try {
      const parsed = parseCommand(line);
      if (!parsed.ok) throw new CommandError(parsed.diagnostic);
      if (!parsed.command) return emptyOutcome();
      if (parsed.command.name === "quit") this.stop();
      return await executeCommand(parsed.command, this.context);
    } catch (error) {
      this.context.log(`command failed: ${errMsg(error)}`);
      const outcome = emptyOutcome(!this.stopped);
      outcome.failures = 1;
      return outcome;
    }
  }
}

/** Execute scripted CLI commands in order. */
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
