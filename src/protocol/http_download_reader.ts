import { finished } from "node:stream/promises";
import { errMsg } from "../shared";
import {
  buildHttpDownloadResult,
  httpDownloadEndDecision,
} from "../transfers";
import type {
  HttpDownloadResult,
  TransferOptions,
} from "../transfers/types";
import type { HttpDownloadState } from "./node_types";
import { DownloadTimeoutError } from "../transfers/errors";

type HttpDownloadSourceHandlers = {
  onChunk: (chunk: Buffer) => void;
  onEnd: () => void;
  onError: (error: unknown) => void;
  onTimeout: () => void;
};

type ReadHttpDownloadSourceArgs = {
  attach: (handlers: HttpDownloadSourceHandlers) => () => void;
  consumeChunk: (
    state: HttpDownloadState,
    destPath: string,
    requestedStart: number,
    onWriteError: (error: Error) => void,
    chunk: Buffer,
  ) => void;
  destPath: string;
  destroyOnFailure?: () => void;
  incompleteMessage: string;
  label: string;
  options?: TransferOptions;
  requestedStart: number;
  timeoutMs: number;
  bodyTimeoutMs: number;
};

function toReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

function readTimeout(
  state: HttpDownloadState,
  label: string,
  requestedStart: number,
  timeoutMs: number,
): DownloadTimeoutError {
  if (!state.headerDone) {
    return new DownloadTimeoutError(
      "headers",
      `download timeout waiting for HTTP headers from ${label} after ${timeoutMs}ms idle (range start=${requestedStart}, header bytes=${state.buf.length})`,
    );
  }
  return new DownloadTimeoutError(
    "body",
    `download body stalled from ${label} after ${timeoutMs}ms idle (offset=${state.finalStart + state.bodyBytes}, response bytes=${state.bodyBytes}, remaining=${state.remaining})`,
  );
}

export async function readHttpDownloadSource({
  attach,
  consumeChunk,
  destPath,
  destroyOnFailure,
  incompleteMessage,
  label,
  options,
  requestedStart,
  timeoutMs,
  bodyTimeoutMs,
}: ReadHttpDownloadSourceArgs): Promise<HttpDownloadResult> {
  return await new Promise((resolve, reject) => {
    const state: HttpDownloadState = {
      buf: Buffer.alloc(0),
      headerDone: false,
      remaining: 0,
      ws: null,
      finalStart: requestedStart,
      bodyBytes: 0,
    };
    let done = false;
    const onWriteError = (error: Error) => fail(error);
    const onAbort = () => fail(new Error("download aborted"));
    const detach = attach({
      onChunk: (chunk) => {
        if (done) return;
        try {
          consumeChunk(
            state,
            destPath,
            requestedStart,
            onWriteError,
            chunk,
          );
        } catch (error) {
          fail(error);
          return;
        }
        if (state.headerDone) {
          options?.onProgress?.({
            bytesCompleted: state.finalStart + state.bodyBytes,
          });
        }
        if (state.headerDone && state.remaining === 0) finish();
      },
      onEnd: () => {
        if (done) return;
        const decision = httpDownloadEndDecision(state, incompleteMessage);
        if (decision.kind === "complete") finish();
        else fail(new Error(decision.message));
      },
      onError: (error) => fail(error),
      onTimeout: () =>
        fail(
          readTimeout(
            state,
            label,
            requestedStart,
            state.headerDone ? bodyTimeoutMs : timeoutMs,
          ),
        ),
    });
    const cleanup = () => {
      detach();
      options?.signal?.removeEventListener("abort", onAbort);
    };

    const settle = async (error?: Error) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) destroyOnFailure?.();
      try {
        if (state.ws) {
          const flushed = finished(state.ws);
          state.ws.end();
          await flushed;
        }
        if (error) reject(error);
        else resolve(buildHttpDownloadResult(state, destPath, label));
      } catch (writeError) {
        destroyOnFailure?.();
        reject(toReadError(writeError));
      } finally {
        state.ws?.off("error", onWriteError);
      }
    };
    const fail = (error: unknown) => {
      void settle(toReadError(error));
    };
    const finish = () => {
      void settle();
    };
    if (options?.signal?.aborted) {
      onAbort();
    } else {
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
