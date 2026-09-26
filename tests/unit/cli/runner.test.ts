import { expect, test } from "bun:test";
import { CommandRunner, runExecCommands } from "../../../src/cli/runner";
import { errMsg } from "../../../src/shared";
import { executionContext } from "../../helpers/cli";
import { makeNode, withTempDir } from "../../helpers/protocol";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("runner serializes rapid input, catches errors, and discards commands after quit", async () => {
  await withTempDir(async (dir) => {
    const logs: string[] = [];
    const events: string[] = [];
    const waiting = gate();
    const sleeping = gate();
    const context = executionContext(
      makeNode(`${dir}/config.json`),
      (line) => logs.push(line),
    );
    context.sleep = async (ms) => {
      events.push(`sleep ${ms}`);
      sleeping.release();
      await waiting.promise;
      events.push("awake");
    };
    context.shutdown = async () => {
      events.push("quit");
    };
    const runner = new CommandRunner(context);
    const first = runner.submit("sleep NaN");
    const second = runner.submit("sleep 0.5");
    const third = runner.submit("query before quit");
    const quit = runner.submit("exit");
    const discarded = runner.submit("monitor on");
    await sleeping.promise;
    expect(events).toEqual(["sleep 500"]);
    expect(context.monitor.get()).toBe("off");
    waiting.release();
    expect((await first).failures).toBe(1);
    await Promise.all([second, third]);
    expect((await quit).keepRunning).toBe(false);
    expect((await discarded).keepRunning).toBe(false);
    expect(events).toEqual(["sleep 500", "awake", "quit"]);
    expect(logs).toContain("no peers connected");
    expect(context.monitor.get()).toBe("off");
  });
});
test("actual script scheduler and REPL submissions share the same queue", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    const sleeping = gate();
    const waiting = gate();
    const finished = gate();
    const context = executionContext(
      makeNode(`${dir}/config.json`),
      (line) => events.push(line),
    );
    context.sleep = async () => {
      sleeping.release();
      await waiting.promise;
    };
    const runner = new CommandRunner(context);
    runExecCommands(
      ["sleep 1", "query script", "quit", "query discarded"],
      context.log,
      async () => {},
      async (line) => {
        const outcome = await runner.submit(line);
        if (!outcome.keepRunning) finished.release();
        return outcome.keepRunning;
      },
      errMsg,
    );
    await sleeping.promise;
    const repl = runner.submit("monitor on");
    const bad = runner.submit("bogus");
    waiting.release();
    await Promise.all([repl, bad, finished.promise]);
    expect(events.indexOf("monitor on")).toBeLessThan(
      events.indexOf("no peers connected"),
    );
    expect(events).toContain("exec> query script");
    expect(events).not.toContain("exec> query discarded");
    expect(
      events.some((e) => e.startsWith("command failed: unknown command")),
    ).toBe(true);
  });
});
test("direct shutdown stop discards pending input without waiting for a long command", async () => {
  await withTempDir(async (dir) => {
    const waiting = gate();
    const sleeping = gate();
    const context = executionContext(makeNode(`${dir}/config.json`));
    context.sleep = async () => {
      sleeping.release();
      await waiting.promise;
    };
    const runner = new CommandRunner(context);
    const first = runner.submit("sleep 100");
    const next = runner.submit("monitor on");
    await sleeping.promise;
    runner.stop();
    waiting.release();
    await first;
    expect((await next).keepRunning).toBe(false);
    expect(context.monitor.get()).toBe("off");
  });
});
