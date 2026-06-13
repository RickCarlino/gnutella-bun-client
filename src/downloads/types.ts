import type { SearchHit } from "../types";

export type DownloadStatus =
  | "queued"
  | "active"
  | "paused"
  | "verifying"
  | "complete"
  | "failed"
  | "verification_failed";

export type DownloadSource = Pick<
  SearchHit,
  | "resultNo"
  | "queryIdHex"
  | "queryHops"
  | "remoteHost"
  | "remotePort"
  | "speedKBps"
  | "fileIndex"
  | "fileName"
  | "fileSize"
  | "serventIdHex"
  | "viaPeerKey"
  | "sha1Urn"
  | "urns"
  | "metadata"
  | "vendorCode"
  | "needsPush"
  | "busy"
> & {
  id: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  cooldownUntil?: number;
};

export type DownloadJob = {
  id: string;
  status: DownloadStatus;
  fileName: string;
  fileSize: number;
  sha1Urn?: string;
  urns: string[];
  destPath: string;
  incompletePath: string;
  bytesCompleted: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  activeSourceId?: string;
  sources: DownloadSource[];
};

export type DownloadStoreDoc = {
  version: 1;
  nextId: number;
  jobs: DownloadJob[];
};

export type DownloadTransferMode = "direct" | "push";
