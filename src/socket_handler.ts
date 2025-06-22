import { Message } from "./core_types";
import { MessageParser } from "./message_parser";
import type { Socket } from "net";
import type { Inflate, Deflate } from "zlib";

export class SocketHandler {
  private socket: Socket;
  private buffer: Buffer;
  private inflater?: Inflate;
  private deflater?: Deflate;
  private compressionEnabled: boolean;
  private onMessage: (msg: Message) => void;
  private onError: (err: Error) => void;
  private onClose: () => void;

  constructor(
    socket: Socket,
    onMessage: (msg: Message) => void,
    onError: (err: Error) => void,
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
    if (!this.compressionEnabled || !this.deflater) {
      this.socket.write(data);
    } else {
      this.deflater.write(data);
    }
  }

  enableCompression(): void {
    if (this.compressionEnabled) return;

    this.compressionEnabled = true;
    this.setupCompression();
  }

  close(): void {
    this.inflater?.end();
    this.deflater?.end();
    this.socket.destroy();
  }

  private setupEventHandlers(): void {
    this.socket.on("data", (chunk: Buffer) => {
      if (!this.compressionEnabled || !this.inflater) {
        this.handleData(chunk);
      } else {
        this.inflater.write(chunk);
      }
    });

    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  private setupCompression(): void {
    const zlib = require("zlib");

    this.inflater = zlib.createInflate();
    this.inflater!.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.inflater!.on("error", this.onError);

    this.deflater = zlib.createDeflate({ flush: zlib.Z_SYNC_FLUSH });
    this.deflater!.on("data", (chunk: Buffer) => this.socket.write(chunk));
    this.deflater!.on("error", this.onError);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const message = MessageParser.parse(this.buffer);
      if (!message) break;

      const size = MessageParser.getMessageSize(message, this.buffer);
      if (size === 0 || this.buffer.length < size) break;

      this.onMessage(message);
      this.buffer = this.buffer.slice(size);
    }
  }
}
