import type { GgepItem } from "./ggep";

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
