import { describe, expect, test } from "bun:test";

import {
  buildMagnetUri,
  parseMagnetUri,
  parseQuery,
  parseQueryHit,
} from "../../../src/protocol";
import { encodeQueryHit } from "../../../src/protocol/codec";
import { bitprintUrnFromHashes } from "../../../src/protocol/content_urn";
import { encodeGgep } from "../../../src/protocol/ggep";
import { sha1ToUrn } from "../../../src/protocol/qrp";
import { makeShare } from "./node/helpers";

describe("protocol content addressing", () => {
  test("parses and rebuilds magnets with bitprints and SHA-1 fallbacks", () => {
    const bitprint =
      "urn:bitprint:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const parsed = parseMagnetUri(
      `magnet:?xt=${encodeURIComponent(bitprint)}&dn=alpha%20beta.bin&xl=1200&xs=${encodeURIComponent("http://1.2.3.4/source")}`,
    );

    expect(parsed).toEqual({
      uri: `magnet:?xt=${encodeURIComponent(bitprint)}&dn=alpha%20beta.bin&xl=1200&xs=${encodeURIComponent("http://1.2.3.4/source")}`,
      displayName: "alpha beta.bin",
      search: "alpha beta.bin",
      size: 1200,
      urns: [bitprint, "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
      sha1Urn: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
      exactSources: ["http://1.2.3.4/source"],
      alternateSources: [],
    });

    expect(
      buildMagnetUri({
        fileName: "alpha beta.bin",
        fileSize: 1200,
        urns: parsed?.urns,
      }),
    ).toBe(
      `magnet:?xt=${encodeURIComponent(bitprint)}&xl=1200&dn=alpha+beta.bin`,
    );
  });

  test("parses GGEP H bitprint queries into bitprint and SHA-1 URNs", () => {
    const sha1 = Buffer.alloc(20, 0x11);
    const tiger = Buffer.alloc(24, 0x22);
    const expectedBitprint = bitprintUrnFromHashes(sha1, tiger);
    const expectedSha1 = sha1ToUrn(sha1);
    const ggep = encodeGgep([
      {
        id: "H",
        data: Buffer.concat([Buffer.from([0x02]), sha1, tiger]),
      },
    ]);
    const payload = Buffer.alloc(3 + ggep.length);
    payload.writeUInt16BE(0, 0);
    payload[2] = 0;
    ggep.copy(payload, 3);

    const parsed = parseQuery(payload);

    expect(parsed.search).toBe("");
    expect(parsed.urns).toEqual([expectedBitprint, expectedSha1]);
  });

  test("encodes and decodes GGEP SHA-1 query hits without duplicating URNs", () => {
    const share = makeShare(1, "/tmp/alpha.txt", "alpha.txt");
    share.sha1Urn = sha1ToUrn(share.sha1!);
    const payload = encodeQueryHit(
      6346,
      "1.2.3.4",
      512,
      [share],
      Buffer.alloc(16, 0x33),
      {
        ggepHashes: true,
      },
    );

    const parsed = parseQueryHit(payload);

    expect(parsed.flagGgep).toBe(true);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.urns).toEqual([share.sha1Urn!]);
  });
});
