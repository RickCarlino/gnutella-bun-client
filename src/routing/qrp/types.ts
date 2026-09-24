export type QrpPatchMessage = {
  seqNo: number;
  seqSize: number;
  compressor: number;
  entryBits: number;
};

export type QrpResetMessage = {
  tableLength: number;
  infinity: number;
};

export type RemoteQrpState = {
  resetSeen: boolean;
  tableSize: number;
  infinity: number;
  entryBits: number;
  table: Uint8Array | null;
  seqSize: number;
  compressor: number;
  parts: Map<number, Buffer>;
};

export type QrpRouteQuery = {
  search: string;
  urns: string[];
};

export type QrpIndexSource = {
  keywords: string[];
};
