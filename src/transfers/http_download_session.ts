import type net from "node:net";
import { DownloadTimeoutError } from "./errors";
import type { TransferService } from "./service";
import type { HttpDownloadResult, TransferOptions } from "./types";

type DownloadSession = {
  transfers: TransferService;
  socket: net.Socket;
  request: (start: number) => string;
  reconnect?: () => Promise<net.Socket>;
  destPath: string;
  label: string;
  start: number;
  options: TransferOptions;
};

function responseTotal(
  result: HttpDownloadResult,
  expected?: number,
): number {
  const total = result.range
    ? (result.range.total ?? expected)
    : result.bytes;
  if (total === undefined)
    throw new Error("unknown partial download size");
  if (expected !== undefined && total !== expected) {
    throw new Error(
      `download size changed: expected ${expected} bytes, got ${total}`,
    );
  }
  if (result.bytes > total)
    throw new Error("download exceeds expected size");
  return total;
}

function needsConnection(
  socket: net.Socket,
  result: HttpDownloadResult,
): boolean {
  return (
    !!result.connectionClose || socket.destroyed || socket.readableEnded
  );
}

/** Request successive ranges until the download is complete. */
export async function downloadHttpSession({
  transfers,
  socket: initialSocket,
  request,
  reconnect,
  destPath,
  label,
  start,
  options,
}: DownloadSession): Promise<HttpDownloadResult> {
  let socket = initialSocket;
  let total = options.expectedSize;
  // Keep errors handled between responses while the file stream flushes.
  const onError = () => {};
  socket.on("error", onError);
  try {
    for (;;) {
      if (options.signal?.aborted) throw new Error("download aborted");
      const pending = transfers.readHttpDownload(
        socket,
        destPath,
        label,
        start,
        options,
      );
      socket.write(request(start));
      const result = await pending;
      total = responseTotal(result, total);
      if (result.bytes === total) return result;
      if (result.bytes <= start)
        throw new Error("download made no progress");
      start = result.bytes;
      if (needsConnection(socket, result)) {
        socket.destroy();
        if (!reconnect)
          throw new Error(
            "push connection closed before full file received",
          );
        socket = await reconnect();
        socket.on("error", onError);
      }
    }
  } finally {
    socket.destroy();
  }
}

/** Connect a download socket with timeout and cancellation. */
export async function connectDownloadSocket(
  transfers: TransferService,
  host: string,
  port: number,
  options: TransferOptions,
): Promise<net.Socket> {
  if (options.signal?.aborted) throw new Error("download aborted");
  const socket = transfers.createConnection({ host, port });
  socket.setNoDelay(true);
  // Also handle errors in the gap between connecting and attaching the reader.
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = transfers.config().downloadTimeoutMs;
    const onTimeout = () =>
      onError(
        new DownloadTimeoutError(
          "connect",
          `download connect timeout to ${host}:${port} after ${timeoutMs}ms`,
        ),
      );
    const cleanup = () => {
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => onError(new Error("download aborted"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.on("timeout", onTimeout);
    socket.setTimeout(timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  return socket;
}
