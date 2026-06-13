import type { DownloadRecord, SearchHit } from "../types";
import type {
  DownloadMode,
  HttpDownloadEndDecision,
  HttpDownloadProgress,
  HttpDownloadResult,
} from "./types";

export function buildDownloadRecord(
  hit: SearchHit,
  destPath: string,
  mode: DownloadMode,
  at: string,
): DownloadRecord {
  return {
    at,
    fileName: hit.fileName,
    bytes: hit.fileSize,
    host: hit.remoteHost,
    port: hit.remotePort,
    mode,
    destPath,
  };
}

export function httpDownloadEndDecision(
  progress: Pick<HttpDownloadProgress, "headerDone" | "remaining">,
  incompleteMessage: string,
): HttpDownloadEndDecision {
  return progress.headerDone && progress.remaining === 0
    ? { kind: "complete" }
    : { kind: "incomplete", message: incompleteMessage };
}

export function buildHttpDownloadResult(
  progress: Pick<HttpDownloadProgress, "finalStart" | "bodyBytes">,
  destPath: string,
  label: string,
): HttpDownloadResult {
  return {
    destPath,
    bytes: progress.finalStart + progress.bodyBytes,
    label,
  };
}
