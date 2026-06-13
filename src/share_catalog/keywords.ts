import path from "node:path";

import { tokenizeKeywords } from "../query_routing/qrp";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function shareKeywords(abs: string, rel: string): string[] {
  return unique([
    ...tokenizeKeywords(path.basename(abs)),
    ...tokenizeKeywords(rel),
    ...tokenizeKeywords(path.parse(abs).name),
  ]);
}
