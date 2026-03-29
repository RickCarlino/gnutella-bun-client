import { describe, expect, test } from "bun:test";

import { encodeQuery, parseQuery } from "../../../src/protocol";
import { splitQuerySearch } from "../../../src/protocol/query_search";

const SHA1_URN = "urn:sha1:HTRIFFS3HO447E6M5RQZBHQ2GGIZCHYR";

describe("query search parsing", () => {
  test("splits inline URNs out of mixed query text", () => {
    expect(splitQuerySearch(`${SHA1_URN} FW2PQUDZ`)).toEqual({
      search: "FW2PQUDZ",
      urns: [SHA1_URN],
    });
  });

  test("parses SHA1-only queries that carry the URN in the search text", () => {
    const parsed = parseQuery(encodeQuery(SHA1_URN));

    expect(parsed.search).toBe("");
    expect(parsed.urns).toEqual([SHA1_URN]);
  });

  test("treats GTK backslash placeholders as empty when URNs are present", () => {
    const parsed = parseQuery(encodeQuery("\\", { urns: [SHA1_URN] }));

    expect(parsed.search).toBe("");
    expect(parsed.urns).toEqual([SHA1_URN]);
  });

  test("preserves four-space index queries", () => {
    const parsed = parseQuery(encodeQuery("    "));

    expect(parsed.search).toBe("    ");
    expect(parsed.urns).toEqual([]);
  });
});
