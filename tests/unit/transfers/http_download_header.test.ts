import { describe, expect, test } from "bun:test";
import { parseHttpDownloadHeader } from "../../../src/wire/codec";

function header(range: string, length = "4"): string {
  return `HTTP/1.1 206 Partial Content\r\nContent-Length: ${length}\r\nContent-Range: ${range}\r\n`;
}

describe("download response ranges", () => {
  test("retains the end and total for a shortened response", () => {
    expect(parseHttpDownloadHeader(header("bytes 4-7/10"), 4)).toEqual({
      finalStart: 4,
      remaining: 4,
      range: { start: 4, end: 7, total: 10 },
    });
    expect(
      parseHttpDownloadHeader(header("bytes 4-7/*"), 4).range,
    ).toEqual({
      start: 4,
      end: 7,
    });
  });

  test.each([
    ["", "4"],
    ["bytes 0-3/10", "4"],
    ["bytes 4-3/10", "0"],
    ["bytes 4-7/7", "4"],
    ["bytes 4-7/10", "5"],
    ["bytes 4-7/10", "-4"],
    ["bytes 4-7/10", "4.0"],
    ["bytes 4-9007199254740992/*", "4"],
  ])(
    "rejects invalid ranges before writing: %s, length %s",
    (range, length) => {
      expect(() =>
        parseHttpDownloadHeader(header(range, length), 4),
      ).toThrow();
    },
  );

  test("recognizes connections that cannot serve another request", () => {
    expect(
      parseHttpDownloadHeader(
        header("bytes 0-3/10") + "Connection: close\r\n",
        0,
      ).connectionClose,
    ).toBe(true);
    expect(
      parseHttpDownloadHeader(
        header("bytes 0-3/10").replace("HTTP/1.1", "HTTP/1.0"),
        0,
      ).connectionClose,
    ).toBe(true);
  });

  test("accepts a full response when the server ignores Range", () => {
    expect(
      parseHttpDownloadHeader(
        "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n",
        4,
      ),
    ).toEqual({ remaining: 10, finalStart: 0 });
  });
});
