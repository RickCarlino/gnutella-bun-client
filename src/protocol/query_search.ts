import { normalizeUrnList } from "./content_urn";

type QuerySearchParts = {
  search: string;
  urns: string[];
};

export function splitQuerySearch(rawSearch: string): QuerySearchParts {
  if (!rawSearch.trim()) {
    return {
      search: rawSearch,
      urns: [],
    };
  }
  const parts = rawSearch.trim().split(/\s+/).filter(Boolean);
  const textParts: string[] = [];
  const rawUrns: string[] = [];
  for (const part of parts) {
    if (!/^urn:[^\s]+$/i.test(part)) {
      textParts.push(part);
      continue;
    }
    rawUrns.push(part);
  }
  return {
    search: textParts.join(" "),
    urns: normalizeUrnList(rawUrns),
  };
}
