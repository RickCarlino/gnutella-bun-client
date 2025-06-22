import { QRPManager } from "./qrp_manager";
import { PeerStore } from "./peer_store";

export interface NodeContext {
  localIp: string;
  localPort: number;
  qrpManager: QRPManager;
  peerStore: PeerStore;
  serventId: Buffer;
}
