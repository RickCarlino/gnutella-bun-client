import path from "node:path";
import type { SearchHit } from "../types";
import type {
  DirectDownloadAttempt,
  DirectDownloadPlanInput,
} from "./types";

/** Clamp a resume offset to a nonnegative integer. */
export function resumeStart(existingBytes: number): number {
  return Math.max(0, Math.trunc(existingBytes));
}

function appendPathSuffix(filePath: string, suffixNo: number): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base} (${suffixNo})${ext}`);
}

/** Add a numeric suffix when choosing another filename. */
export function downloadPathCandidate(
  basePath: string,
  suffixNo: number,
): string {
  return suffixNo === 1 ? basePath : appendPathSuffix(basePath, suffixNo);
}

/** Plan URN lookup followed by indexed GET fallback. */
export function directDownloadAttempts(
  input: DirectDownloadPlanInput,
): DirectDownloadAttempt[] {
  const existingBytes = resumeStart(input.existingBytes);
  const getAttempt: DirectDownloadAttempt = {
    kind: "get",
    fileIndex: input.fileIndex,
    fileName: input.fileName,
    existingBytes,
    fallbackOnFailure: false,
  };
  if (!input.serveUriRes || !input.sha1Urn) return [getAttempt];
  return [
    {
      kind: "uri-res",
      urn: input.sha1Urn,
      existingBytes,
      fallbackOnFailure: true,
    },
    getAttempt,
  ];
}

/** Allow push fallback for any search hit. */
export function shouldTryPushFallback(_hit: SearchHit): boolean {
  return true;
}
