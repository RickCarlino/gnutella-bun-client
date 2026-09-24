type DownloadTimeoutPhase = "connect" | "headers" | "body";

/** Identifies a stalled download. */
export class DownloadTimeoutError extends Error {
  /** Create a timeout error with its diagnostic message. */
  constructor(
    readonly phase: DownloadTimeoutPhase,
    message: string,
  ) {
    super(message);
    this.name = "DownloadTimeoutError";
  }
}
