import type { GnutellaServent } from "../servent";
import {
  type Domain,
  type Selector,
  type SelectorItem,
} from "./selectors";
import { CommandError } from "./tokens";

export type Target = {
  domain: Domain;
  id: string;
  number: number;
  status?: string;
};
type SnapshotNode = Pick<
  GnutellaServent,
  "getDownloadJobs" | "getSearches" | "getResults"
>;
/** Detach only identity/status data: command membership cannot grow during execution. */
export function takeSnapshot(
  node: SnapshotNode,
  domain: Domain,
): Target[] {
  if (domain === "downloads")
    return node.getDownloadJobs().map((job) => ({
      domain,
      id: job.id,
      number: Number(job.id.slice(1)),
      status: job.status,
    }));
  const searches = node.getSearches();
  if (domain === "searches")
    return searches.map((s) => ({
      domain,
      id: s.id,
      number: s.number,
      status: s.status,
    }));
  return searches.flatMap((s) =>
    node.getResults(s.id).map((r) => ({
      domain,
      id: String(r.resultNo),
      number: r.resultNo,
    })),
  );
}
function matches(item: SelectorItem, target: Target): boolean {
  switch (item.kind) {
    case "range":
      return target.number >= item.first && target.number <= item.last;
    case "keyword":
      return item.value === "all" || target.status === item.value;
    case "reference":
      return item.number === undefined
        ? target.id === item.value
        : target.number === item.number;
  }
}
export function resolveSelector(
  selector: Selector,
  snapshot: readonly Target[],
): Target[] {
  const sorted = snapshot
    .filter((t) => t.domain === selector.domain)
    .sort((a, b) => a.number - b.number);
  const targets = new Map<string, Target>();
  for (const item of selector.items) {
    const found = sorted.filter((target) => matches(item, target));
    if (!found.length && item.kind === "reference")
      throw new CommandError({
        message: `no such ${selector.domain === "searches" ? "search" : selector.domain === "downloads" ? "download" : "result"} ${item.value}`,
        span: item.span,
        usage: "",
      });
    for (const target of found)
      if (!targets.has(target.id)) targets.set(target.id, target);
  }
  return [...targets.values()];
}
