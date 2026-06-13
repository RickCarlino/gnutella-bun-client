import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildDownloadRecord,
  buildHttpDownloadResult,
  directDownloadAttempts,
  downloadPathCandidate,
  httpDownloadEndDecision,
  parseByteRange,
  resumeStart,
  shouldTryPushFallback,
} from "../../../src/transfers";
import type { SearchHit } from "../../../src/types";

function hit(patch: Partial<SearchHit> = {}): SearchHit {
  return {
    resultNo: 7,
    queryIdHex: "aa".repeat(16),
    queryHops: 2,
    remoteHost: "9.8.7.6",
    remotePort: 4321,
    speedKBps: 128,
    fileIndex: 5,
    fileName: "alpha.txt",
    fileSize: 99,
    serventIdHex: "11".repeat(16),
    viaPeerKey: "p1",
    ...patch,
  };
}

describe("transfer planning", () => {
  test("parses HTTP byte ranges", () => {
    expect(parseByteRange(undefined, 10)).toEqual({
      start: 0,
      end: 9,
      partial: false,
    });
    expect(parseByteRange("bytes=5-", 10)).toEqual({
      start: 5,
      end: 9,
      partial: true,
    });
    expect(parseByteRange("bytes=-5", 10)).toEqual({
      start: 5,
      end: 9,
      partial: true,
    });
    expect(parseByteRange("bytes=99-120", 5)).toBeNull();
    expect(parseByteRange("bytes=-0", 10)).toBeNull();
  });

  test("plans resume starts and destination filename candidates", () => {
    const base = path.join("/downloads", "alpha.txt");

    expect(resumeStart(5)).toBe(5);
    expect(resumeStart(-1)).toBe(0);
    expect(resumeStart(5.9)).toBe(5);
    expect(downloadPathCandidate(base, 1)).toBe(base);
    expect(downloadPathCandidate(base, 2)).toBe(
      path.join("/downloads", "alpha (2).txt"),
    );
  });

  test("plans direct URI-res fallback before /get downloads", () => {
    expect(
      directDownloadAttempts({
        ...hit({ sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
        existingBytes: 5,
        serveUriRes: true,
      }),
    ).toEqual([
      {
        kind: "uri-res",
        urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        existingBytes: 5,
        fallbackOnFailure: true,
      },
      {
        kind: "get",
        fileIndex: 5,
        fileName: "alpha.txt",
        existingBytes: 5,
        fallbackOnFailure: false,
      },
    ]);

    expect(
      directDownloadAttempts({
        ...hit({ sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
        existingBytes: 0,
        serveUriRes: false,
      }).map((attempt) => attempt.kind),
    ).toEqual(["get"]);
    expect(
      directDownloadAttempts({
        ...hit(),
        existingBytes: 0,
        serveUriRes: true,
      }).map((attempt) => attempt.kind),
    ).toEqual(["get"]);
  });

  test("builds download records and push fallback decisions", () => {
    expect(
      buildDownloadRecord(hit(), "/downloads/alpha.txt", "direct", "now"),
    ).toEqual({
      at: "now",
      fileName: "alpha.txt",
      bytes: 99,
      host: "9.8.7.6",
      port: 4321,
      mode: "direct",
      destPath: "/downloads/alpha.txt",
    });
    expect(shouldTryPushFallback(hit())).toBe(true);
  });

  test("decides HTTP completion and builds download results", () => {
    expect(
      httpDownloadEndDecision(
        { headerDone: true, remaining: 0 },
        "truncated",
      ),
    ).toEqual({ kind: "complete" });
    expect(
      httpDownloadEndDecision(
        { headerDone: true, remaining: 2 },
        "truncated",
      ),
    ).toEqual({ kind: "incomplete", message: "truncated" });
    expect(
      httpDownloadEndDecision(
        { headerDone: false, remaining: 0 },
        "truncated",
      ),
    ).toEqual({ kind: "incomplete", message: "truncated" });
    expect(
      buildHttpDownloadResult(
        { finalStart: 5, bodyBytes: 3 },
        "/downloads/resume.bin",
        "9.8.7.6:4321",
      ),
    ).toEqual({
      destPath: "/downloads/resume.bin",
      bytes: 8,
      label: "9.8.7.6:4321",
    });
  });
});
