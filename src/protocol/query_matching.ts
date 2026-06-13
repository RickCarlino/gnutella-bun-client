import type { QueryDescriptor, ShareFile } from "../types";
import { tokenizeKeywords } from "../query_routing/qrp";

export function matchQuery(
  q: QueryDescriptor,
  share: Pick<ShareFile, "name" | "sha1Urn" | "keywords">,
): boolean {
  if (q.urns.length) {
    if (!share.sha1Urn) return false;
    const urnSet = new Set(q.urns.map((x) => x.toLowerCase()));
    if (!urnSet.has(share.sha1Urn.toLowerCase())) return false;
  }
  const term = q.search.trim();
  if (!term) return q.urns.length > 0;
  const kws = tokenizeKeywords(term);
  if (!kws.length)
    return share.name.toLowerCase().includes(term.toLowerCase());
  const shareKw = new Set(share.keywords);
  return kws.every(
    (kw) => shareKw.has(kw) || share.name.toLowerCase().includes(kw),
  );
}
