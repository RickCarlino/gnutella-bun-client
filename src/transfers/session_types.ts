import type fs from "node:fs";
import type net from "node:net";
import type { HttpDownloadResult } from "./types";

export type HttpSession = {
  socket: net.Socket;
  buf: Buffer;
  busy: boolean;
  drainRequested: boolean;
  closed: boolean;
};

export type HttpSessionRequest = {
  head: string;
  body: Buffer;
};

export type ExistingGetRequest = {
  method: string;
  responseVersion: string;
  headers: Record<string, string>;
  keepAlive: boolean;
};

export type HttpDownloadState = Pick<
  HttpDownloadResult,
  "range" | "connectionClose"
> & {
  buf: Buffer;
  headerDone: boolean;
  remaining: number;
  ws: fs.WriteStream | null;
  finalStart: number;
  bodyBytes: number;
};
