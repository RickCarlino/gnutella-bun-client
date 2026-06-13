import {
  canRouteRemoteQrpQuery,
  type QrpRouteQuery,
  type RemoteQrpState,
} from "./qrp";

export type QueryRoutingNodeMode = "leaf" | "ultrapeer";
export type QueryRouteCandidateRole = "leaf" | "mesh";

export type QueryRouteCandidate<Id = string> = {
  id: Id;
  role: QueryRouteCandidateRole;
  remoteQrp?: RemoteQrpState;
  supportsLastHopQrp?: boolean;
};

export type QueryRouteTarget<Id = string> = {
  id: Id;
  ttl: number;
  hops: number;
};

export type SelectQueryRouteTargetsOptions<Id = string> = {
  nodeMode: QueryRoutingNodeMode;
  enableQrp: boolean;
  query: QrpRouteQuery;
  candidates: QueryRouteCandidate<Id>[];
  ttl: number;
  hops: number;
  localOrigin?: boolean;
};

function qrpTableReady(remoteQrp: RemoteQrpState | undefined): boolean {
  return !!remoteQrp?.table;
}

function canRouteToCandidate(
  enableQrp: boolean,
  query: QrpRouteQuery,
  candidate: QueryRouteCandidate<unknown>,
): boolean {
  if (!enableQrp) return true;
  if (candidate.role === "leaf") {
    return (
      qrpTableReady(candidate.remoteQrp) &&
      canRouteRemoteQrpQuery(candidate.remoteQrp!, query)
    );
  }
  if (!candidate.supportsLastHopQrp) return true;
  if (!qrpTableReady(candidate.remoteQrp)) return true;
  return canRouteRemoteQrpQuery(candidate.remoteQrp!, query);
}

function leafTarget<Id>(
  options: SelectQueryRouteTargetsOptions<Id>,
  candidate: QueryRouteCandidate<Id>,
): QueryRouteTarget<Id> | undefined {
  if (candidate.role !== "leaf") return undefined;
  if (!canRouteToCandidate(options.enableQrp, options.query, candidate))
    return undefined;
  return {
    id: candidate.id,
    ttl: Math.max(1, options.ttl),
    hops: options.hops,
  };
}

function localOriginMeshTarget<Id>(
  options: SelectQueryRouteTargetsOptions<Id>,
  candidate: QueryRouteCandidate<Id>,
): QueryRouteTarget<Id> | undefined {
  if (options.ttl <= 0) return undefined;
  if (
    options.nodeMode === "ultrapeer" &&
    options.ttl === 1 &&
    !canRouteToCandidate(options.enableQrp, options.query, candidate)
  ) {
    return undefined;
  }
  return { id: candidate.id, ttl: options.ttl, hops: options.hops };
}

function relayedMeshTarget<Id>(
  options: SelectQueryRouteTargetsOptions<Id>,
  candidate: QueryRouteCandidate<Id>,
): QueryRouteTarget<Id> | undefined {
  if (options.ttl <= 0 || options.nodeMode === "leaf") return undefined;
  if (options.nodeMode === "ultrapeer" && options.ttl === 1) {
    if (!canRouteToCandidate(options.enableQrp, options.query, candidate))
      return undefined;
    return { id: candidate.id, ttl: 1, hops: options.hops };
  }
  return {
    id: candidate.id,
    ttl: options.ttl - 1,
    hops: options.hops + 1,
  };
}

export function selectQueryRouteTargets<Id = string>(
  options: SelectQueryRouteTargetsOptions<Id>,
): QueryRouteTarget<Id>[] {
  const targets: QueryRouteTarget<Id>[] = [];
  for (const candidate of options.candidates) {
    const leaf = leafTarget(options, candidate);
    if (leaf) {
      targets.push(leaf);
      continue;
    }
    if (candidate.role === "leaf") continue;
    const mesh = options.localOrigin
      ? localOriginMeshTarget(options, candidate)
      : relayedMeshTarget(options, candidate);
    if (mesh) targets.push(mesh);
  }
  return targets;
}
