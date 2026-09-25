import { printQueries, printResults } from "./cli_shared";
import type { SearchSession } from "./search/types";
import type { GnutellaServent } from "./servent";

type SearchNode = Pick<
  GnutellaServent,
  | "getSearches"
  | "getResults"
  | "sendQuery"
  | "browsePeer"
  | "clearResults"
>;

/** Stateless search commands; the search service owns sessions and results. */
export class CliSearches {
  /** Attach the search actions and read APIs. */
  constructor(private readonly node: SearchNode) {}

  private resolve(reference: string): SearchSession {
    const search = this.node
      .getSearches()
      .find(
        (entry) =>
          entry.id === reference ||
          `q${entry.number}` === reference.toLowerCase(),
      );
    if (!search) throw new Error(`no such search ${reference}`);
    return search;
  }

  private heading(search: SearchSession): string {
    return `q${search.number}: ${JSON.stringify(search.search)}`;
  }

  /** Handle search commands for both the REPL and --exec. */
  async command(
    command: string,
    args: string[],
    log: (message: string) => void,
  ): Promise<void> {
    switch (command) {
      case "query":
        return this.query(args, log);
      case "browse":
        return this.browse(args, log);
      case "queries":
        return this.list(args, log);
      case "results":
        return this.print(args, log);
      case "clear":
        return this.clear(args);
      default:
        throw new Error(`unknown search command: ${command}`);
    }
  }

  private checkLength(
    args: string[],
    length: number,
    usage: string,
  ): void {
    if (args.length !== length) throw new Error(`usage: ${usage}`);
  }

  private query(args: string[], log: (message: string) => void): void {
    const text = args.slice(1).join(" ");
    if (!text.trim()) throw new Error("usage: query <search terms...>");
    const search = this.node.sendQuery(text);
    if (search) log(this.heading(search));
    else log("no peers connected");
  }

  private async browse(
    args: string[],
    log: (message: string) => void,
  ): Promise<void> {
    this.checkLength(args, 2, "browse <peerKey|ip:port>");
    log(this.heading(await this.node.browsePeer(args[1]!)));
  }

  private list(args: string[], log: (message: string) => void): void {
    this.checkLength(args, 1, "queries");
    printQueries(this.node.getSearches(), log);
  }

  private clear(args: string[]): void {
    if (args.length > 2) throw new Error("usage: clear [query]");
    if (!args[1]) {
      this.node.clearResults();
      return;
    }
    const search = this.resolve(args[1]);
    this.node.clearResults(search.id);
  }

  private print(args: string[], log: (message: string) => void): void {
    if (args.length > 2) throw new Error("usage: results [query]");
    const searches = args[1]
      ? [this.resolve(args[1])]
      : this.node.getSearches();
    const lines: string[] = [];
    for (const [index, search] of searches.entries()) {
      if (index > 0) lines.push("");
      lines.push(this.heading(search));
      printResults(this.node, (text) => lines.push(text), search.id);
    }
    log(lines.join("\n") || "no searches");
  }
}
