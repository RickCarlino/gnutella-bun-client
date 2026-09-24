import zlib from "node:zlib";
import { errMsg, toBuffer } from "../shared";
import type { GnutellaServentCollaborators } from "../types";
import type { PeerConnection as Peer } from "./types";

type SessionDependencies = {
  consume: (peer: Peer) => void;
  dropped: (peer: Peer, message: string) => void;
  scheduler: Pick<
    GnutellaServentCollaborators["scheduler"],
    "setTimeout" | "clearTimeout"
  >;
};

/** Owns a peer's compression, listeners, and timers. */
export class PeerSession {
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();

  /** Attach a peer and its session dependencies. */
  constructor(
    readonly peer: Peer,
    private readonly deps: SessionDependencies,
  ) {}

  /** Install stream handlers and consume buffered bytes. */
  start(initialBuf: Buffer): void {
    const { socket, capabilities } = this.peer;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    if (capabilities.compressOut) {
      const deflater = zlib.createDeflate();
      this.peer.deflater = deflater;
      deflater.on("data", (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      });
      deflater.on("error", (error) =>
        this.fail(`deflater error: ${errMsg(error)}`),
      );
    }
    if (capabilities.compressIn) {
      const inflater = zlib.createInflate();
      this.peer.inflater = inflater;
      inflater.on("data", (chunk) => this.feedDecoded(toBuffer(chunk)));
      inflater.on("error", (error) =>
        this.fail(`inflater error: ${errMsg(error)}`),
      );
    }
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    socket.on("error", this.onError);
    if (initialBuf.length) this.onData(initialBuf);
  }

  /** Schedule a callback canceled when the session closes. */
  schedule(ms: number, callback: () => void): void {
    const timer = this.deps.scheduler.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) callback();
    }, ms);
    this.timers.add(timer);
  }

  /** Release session resources and report the dropped peer. */
  close(message: string): void {
    if (this.closed) return;
    this.closed = true;
    const { socket, inflater, deflater } = this.peer;
    socket.off("data", this.onData);
    socket.off("close", this.onClose);
    socket.off("error", this.onError);
    inflater?.destroy();
    deflater?.destroy();
    for (const timer of this.timers)
      this.deps.scheduler.clearTimeout(timer);
    this.timers.clear();
    this.deps.dropped(this.peer, message);
  }

  private fail(message: string): void {
    this.close(message);
    this.peer.socket.destroy();
  }

  private feedDecoded(chunk: Buffer): void {
    if (this.closed) return;
    this.peer.buf = Buffer.concat([this.peer.buf, chunk]);
    try {
      this.deps.consume(this.peer);
    } catch (error) {
      this.fail(errMsg(error));
    }
  }

  private readonly onData = (chunk: string | Buffer): void => {
    if (this.closed) return;
    const data = toBuffer(chunk);
    if (this.peer.inflater) this.peer.inflater.write(data);
    else this.feedDecoded(data);
  };

  private readonly onClose = (): void => this.close("socket closed");
  private readonly onError = (error: Error): void =>
    this.fail(errMsg(error));
}
