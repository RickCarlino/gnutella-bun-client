import { QRP_MAX_CUT_CHARS, QRP_MIN_WORD_LENGTH } from "./constants";

export function splitSearchTerms(input: string): string[] {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return ascii.split(/[^a-z0-9]+/).filter(Boolean);
}

export function tokenizeKeywords(input: string): string[] {
  return [...new Set(splitSearchTerms(input).filter((x) => x.length > 1))];
}

export function qrpQueryTerms(input: string): string[] {
  return [
    ...new Set(
      splitSearchTerms(input).filter(
        (x) => x.length >= QRP_MIN_WORD_LENGTH,
      ),
    ),
  ];
}

export function qrpIndexTerms(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of qrpQueryTerms(input)) {
    let candidate = term;
    for (let trim = 0; trim <= QRP_MAX_CUT_CHARS; trim++) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      if (candidate.length <= QRP_MIN_WORD_LENGTH) break;
      const next = candidate.slice(0, -1);
      if (next.length <= QRP_MIN_WORD_LENGTH) break;
      candidate = next;
    }
  }
  return out;
}

function qrpWordHitThreshold(hit: number, word: number): boolean {
  return word < 3 ? hit === word : Math.trunc((3 * hit) / word) >= 2;
}

export function qrpTermsMatch(
  terms: string[],
  hasTerm: (term: string) => boolean,
): boolean {
  if (!terms.length) return true;
  let hit = 0;
  for (const term of terms) {
    if (hasTerm(term)) hit++;
  }
  return qrpWordHitThreshold(hit, terms.length);
}

export function qrpPresenceHit(value: number, infinity: number): boolean {
  return value < infinity;
}
