import path from "node:path";

import type { SearchHit } from "../types";
import type {
  DirectDownloadAttempt,
  DirectDownloadPlanInput,
} from "./types";

export function resumeStart(existingBytes: number): number {
  return Math.max(0, Math.trunc(existingBytes));
}

function appendPathSuffix(filePath: string, suffixNo: number): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base} (${suffixNo})${ext}`);
}

export function downloadPathCandidate(
  basePath: string,
  suffixNo: number,
): string {
  return suffixNo === 1 ? basePath : appendPathSuffix(basePath, suffixNo);
}

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

export function shouldTryPushFallback(_hit: SearchHit): boolean {
  return true;
}
