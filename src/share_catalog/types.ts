export type ShareCatalogFile = {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
};

export type ShareCatalogEntry = {
  rel: string;
  size: number;
  mtimeMs: number;
  sha1Hex?: string;
  sha1Urn?: string;
};

export type ShareCatalogHash = {
  sha1: Buffer;
  sha1Hex: string;
  sha1Urn: string;
};

export type ShareCatalogShare = {
  index: number;
  name: string;
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  sha1?: Buffer;
  sha1Urn?: string;
  keywords: string[];
};

export type ShareCatalogBuildResult = {
  shares: ShareCatalogShare[];
  entries: Map<string, ShareCatalogEntry>;
  pendingHashes: ShareCatalogShare[];
};

export type ShareHashApplication = {
  share: ShareCatalogShare;
  entry: ShareCatalogEntry;
};
