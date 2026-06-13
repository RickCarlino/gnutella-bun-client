export { canAcceptPeerRole, shouldRelayForMode } from "./admission";
export {
  classifyRemotePeerRole,
  isLeafPeerRole,
  isMeshPeerRole,
} from "./classify";
export {
  availableDialSlots,
  countLeafPeers,
  countMeshPeers,
  countPeersByRole,
} from "./slots";
export type {
  AdmissionResult,
  PeerRoleSummary,
  TopologySlotState,
} from "./types";
