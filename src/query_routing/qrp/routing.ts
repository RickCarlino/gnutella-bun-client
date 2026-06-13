import { QrpTable } from "./table";
import { qrpQueryTerms, qrpTermsMatch } from "./terms";
import type { QrpRouteQuery, RemoteQrpState } from "./types";

function canRouteQrpQuery(
  q: QrpRouteQuery,
  hasTerm: (term: string) => boolean,
): boolean {
  for (const urn of q.urns) {
    if (hasTerm(urn)) return true;
  }
  const terms = qrpQueryTerms(q.search);
  if (!terms.length) return false;
  return qrpTermsMatch(terms, hasTerm);
}

export function canRouteRemoteQrpQuery(
  state: RemoteQrpState,
  q: QrpRouteQuery,
): boolean {
  return canRouteQrpQuery(q, (term) =>
    QrpTable.remoteHasTerm(state, term),
  );
}

export function buildAggregateQrpTable(
  ownTable: QrpTable,
  remoteTables: RemoteQrpState[],
  options: { maxTableSize?: number } = {},
): QrpTable {
  const maxTableSize = options.maxTableSize ?? Number.MAX_SAFE_INTEGER;
  let tableSize = ownTable.tableSize;
  for (const remote of remoteTables) {
    if (!remote.table) continue;
    tableSize = Math.max(tableSize, remote.tableSize);
  }
  const table = new QrpTable(
    Math.min(tableSize, maxTableSize),
    ownTable.infinity,
    1,
  );
  table.clear();
  table.mergeFromQrp(ownTable);
  for (const remote of remoteTables) table.mergeFromRemoteQrp(remote);
  return table;
}
