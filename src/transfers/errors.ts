type DownloadTimeoutPhase = "connect" | "headers" | "body";

export class DownloadTimeoutError extends Error {
  constructor(
    readonly phase: DownloadTimeoutPhase,
    message: string,
  ) {
    super(message);
    this.name = "DownloadTimeoutError";
  }
}
