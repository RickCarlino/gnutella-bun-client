import type { TransferOptions } from "../transfers/types";
import type {
  GnutellaEventListener,
  RuntimeConfig,
  SearchHit,
} from "../types";
import type { readDownloadStore, writeDownloadStore } from "./store";

export type DownloadTransfers = {
  direct: (
    hit: SearchHit,
    destination: string,
    options?: TransferOptions,
  ) => Promise<void>;
  push: (
    hit: SearchHit,
    destination: string,
    options?: TransferOptions,
  ) => Promise<void>;
};

export type DownloadDependencies = {
  config: () => Pick<
    RuntimeConfig,
    | "dataDir"
    | "downloadsDir"
    | "incompleteDownloadsDir"
    | "downloadRetryLimit"
    | "downloadMaxActivePerHost"
    | "downloadQueueSize"
    | "downloadRetryBackoffSec"
    | "verifyDownloads"
  >;
  now: () => number;
  schedule: (delay: number, callback: () => void) => NodeJS.Timeout;
  cancel: (timer: NodeJS.Timeout) => void;
  emit: GnutellaEventListener;
  onError: (error: unknown) => void;
  transfers: DownloadTransfers;
  store?: {
    read: typeof readDownloadStore;
    write: typeof writeDownloadStore;
  };
};
