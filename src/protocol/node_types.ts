import fs from "node:fs";
import net from "node:net";
import zlib from "node:zlib";

import type { PeerCapabilities, PeerRole, RemoteQrpState } from "../types";
import type { GgepItem } from "./ggep";

export type ProbeCtx = {
  socket: net.Socket;
  buf: Buffer;
  receivedBytes: number;
  startedAtMs: number;
  mode: "undecided" | "await-final-0.6" | "done";
  requestHeaders?: Record<string, string>;
  serverHeaders?: Record<string, string>;
  onData?: (chunk: string | Buffer) => void;
  onEnd?: () => void;
  onClose?: (hadError: boolean) => void;
  onError?: (error: unknown) => void;
};

export type HttpSession = {
  socket: net.Socket;
  buf: Buffer;
  busy: boolean;
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

export type HttpDownloadState = {
  buf: Buffer;
  headerDone: boolean;
  remaining: number;
  ws: fs.WriteStream | null;
  finalStart: number;
  bodyBytes: number;
};

export type Peer = {
  key: string;
  socket: net.Socket;
  buf: Buffer;
  outbound: boolean;
  dialTarget?: string;
  remoteLabel: string;
  role: PeerRole;
  capabilities: PeerCapabilities;
  inflater?: zlib.Inflate;
  deflater?: zlib.Deflate;
  remoteQrp: RemoteQrpState;
  lastPingAt: number;
  connectedAt: number;
  closingAfterBye?: boolean;
};

export type DescriptorHeader = {
  descriptorId: Buffer;
  descriptorIdHex: string;
  payloadType: number;
  ttl: number;
  hops: number;
  payloadLength: number;
};

export type QueryHitResult = {
  fileIndex: number;
  fileSize: number;
  fileName: string;
  urns: string[];
  metadata: string[];
  rawExtension: Buffer;
};

export type QueryHitEncodeOptions = {
  vendorCode?: string;
  push?: boolean;
  busy?: boolean;
  haveUploaded?: boolean;
  measuredSpeed?: boolean;
  ggepHashes?: boolean;
  browseHost?: boolean;
  privateGgepItems?: GgepItem[];
};

export type QueryEncodeOptions = {
  requesterFirewalled?: boolean;
  wantsXml?: boolean;
  leafGuidedDynamic?: boolean;
  ggepHAllowed?: boolean;
  outOfBand?: boolean;
  maxHits?: number;
  urns?: string[];
  xmlBlocks?: string[];
  ggepItems?: GgepItem[];
};
