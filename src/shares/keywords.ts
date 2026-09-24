import path from "node:path";
import { tokenizeKeywords } from "../routing/qrp";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Extract distinct keywords from file and relative paths. */
export function shareKeywords(abs: string, rel: string): string[] {
  return unique([
    ...tokenizeKeywords(path.basename(abs)),
    ...tokenizeKeywords(rel),
    ...tokenizeKeywords(path.parse(abs).name),
  ]);
}
