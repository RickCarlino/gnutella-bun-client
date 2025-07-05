import { MessageParser } from "./MessageParser";
import * as net from "net";
import * as zlib from "zlib";
import { GnutellaMessage } from "./types";

export class SocketHandler {
  private socket: net.Socket;
  private buffer: Buffer;
  private compressionEnabled: boolean;
  private inflater?: zlib.Inflate;
  private deflater?: zlib.Deflate;
  private onMessage: (message: GnutellaMessage) => void;
  private onError: (error: Error) => void;
  private onClose: () => void;

  constructor(
    socket: net.Socket,
    onMessage: (message: GnutellaMessage) => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.compressionEnabled = false;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
    this.setupEventHandlers();
  }

  send(data: Buffer): void {
    const target =
      this.compressionEnabled && this.deflater ? this.deflater : this.socket;
    target.write(data);
  }

  enableCompression(): void {
    if (this.compressionEnabled) {
      return;
    }
    this.compressionEnabled = true;
    this.setupCompression();
  }

  close(): void {
    this.inflater?.end();
    this.deflater?.end();
    this.socket.destroy();
  }

  private setupEventHandlers(): void {
    this.socket.on("data", (chunk) => {
      if (this.compressionEnabled && this.inflater) {
        this.inflater.write(chunk);
      } else {
        this.handleData(chunk);
      }
    });
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  private setupCompression(): void {
    this.inflater = zlib.createInflate();
    this.inflater.on("data", (chunk) => this.handleData(chunk));
    this.inflater.on("error", this.onError);

    this.deflater = zlib.createDeflate({ flush: zlib.Z_SYNC_FLUSH });
    this.deflater.on("data", (chunk) => this.socket.write(chunk));
    this.deflater.on("error", this.onError);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const message = MessageParser.parse(this.buffer);
      if (!message) {
        break;
      }

      const size = MessageParser.getMessageSize(message, this.buffer);
      if (size === 0 || this.buffer.length < size) {
        break;
      }

      this.onMessage(message);
      this.buffer = this.buffer.slice(size);
    }
  }
}
