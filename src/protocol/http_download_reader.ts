import { errMsg } from "../shared";
import type { HttpDownloadState } from "./node_types";

type HttpDownloadSourceHandlers = {
  onChunk: (chunk: Buffer) => void;
  onEnd: () => void;
  onError: (error: unknown) => void;
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
  requestedStart: number;
};

function toReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

export async function readHttpDownloadSource({
  attach,
  consumeChunk,
  destPath,
  destroyOnFailure,
  incompleteMessage,
  label,
  requestedStart,
}: ReadHttpDownloadSourceArgs): Promise<unknown> {
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
        if (state.headerDone && state.remaining === 0) finish();
      },
      onEnd: () => {
        if (!done && state.headerDone && state.remaining === 0) finish();
        else if (!done) fail(new Error(incompleteMessage));
      },
      onError: (error) => fail(error),
    });

    const cleanup = () => {
      detach();
      state.ws?.off("error", onWriteError);
    };

    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        state.ws?.destroy();
      } catch {
        // ignore
      }
      try {
        destroyOnFailure?.();
      } catch {
        // ignore
      }
      reject(toReadError(error));
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      const meta = {
        destPath,
        bytes: state.finalStart + state.bodyBytes,
        label,
      };
      if (!state.ws) {
        resolve(meta);
        return;
      }
      state.ws.end(() => resolve(meta));
    };
  });
}
