import { describe, expect, test } from "bun:test";

import { buildGetRequest } from "../../../src/protocol";
import {
  HttpByteStreamBuffer,
  RTC_CHANNEL_LABEL,
  RTC_CHANNEL_PROTOCOL,
  createRtcPeerConnection,
  encodeRtcHitGgep,
  encodeRtcQueryGgep,
  parseRtcHitGgep,
  parseRtcQueryGgep,
  sanitizeRtcStunUrls,
  waitForRtcDataChannelOpen,
} from "../../../src/protocol/rtc_signal";
import type {
  RTCDataChannel,
  WeriftPeerConnection,
} from "../../../src/protocol/werift_local";

function sendChunks(channel: RTCDataChannel, chunks: Buffer[]): void {
  for (const chunk of chunks) channel.send(chunk);
}

function waitForIncomingDataChannel(
  peer: WeriftPeerConnection,
  expectedLabel: string,
  expectedProtocol: string,
  timeoutMs = 15_000,
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for incoming RTC data channel"));
    }, timeoutMs);
    peer.ondatachannel = ({ channel }) => {
      if (
        channel.label !== expectedLabel ||
        channel.protocol !== expectedProtocol
      ) {
        clearTimeout(timer);
        reject(
          new Error(
            `unexpected data channel ${channel.label}/${channel.protocol}`,
          ),
        );
        return;
      }
      clearTimeout(timer);
      resolve(channel);
    };
  });
}

function waitForHttpRequest(channel: RTCDataChannel): Promise<string> {
  const buffer = new HttpByteStreamBuffer();
  return new Promise((resolve) => {
    channel.onmessage = (event) => {
      buffer.append(Buffer.from(event.data));
      const request = buffer.takeRequest();
      if (request) resolve(request);
    };
  });
}

function waitForHttpResponse(
  channel: RTCDataChannel,
  requestedStart: number,
): Promise<{ body: Buffer; finalStart: number; headerText: string }> {
  const buffer = new HttpByteStreamBuffer();
  return new Promise((resolve) => {
    channel.onmessage = (event) => {
      buffer.append(Buffer.from(event.data));
      const response = buffer.takeResponse(requestedStart);
      if (response) {
        resolve({
          body: response.body,
          finalStart: response.finalStart,
          headerText: response.headerText,
        });
      }
    };
  });
}

describe("rtc signaling", () => {
  test("encodes rtc query and hit ggep with rendezvous endpoints", () => {
    const cookie = Buffer.alloc(20, 0x42);
    const rendezvousEndpoints = [
      { host: "127.0.0.1", port: 7777 },
      { host: "203.0.113.7", port: 6346 },
    ];
    const queryGgep = encodeRtcQueryGgep();
    const hitGgep = encodeRtcHitGgep({
      cookie,
      rendezvousEndpoints,
    });

    expect(parseRtcQueryGgep(queryGgep)).toEqual({
      version: 1,
    });
    expect(parseRtcHitGgep(hitGgep)).toEqual({
      version: 1,
      cookie,
      rendezvousEndpoints,
    });
  });

  test("sanitizes repeated stun hints and ignores non-stun urls", () => {
    expect(
      sanitizeRtcStunUrls([
        " stun:stun-a.example.net:3478 ",
        "turn:turn.example.net:3478",
        "STUN:stun-a.example.net:3478",
        "stun:stun-b.example.net:3478",
        "stuns:stuns.example.net:5349",
        "stun:stun-c.example.net:3478",
        "stun:stun-d.example.net:3478",
        "stun:stun-e.example.net:3478",
      ]),
    ).toEqual([
      "stun:stun-a.example.net:3478",
      "stun:stun-b.example.net:3478",
      "stun:stun-c.example.net:3478",
      "stun:stun-d.example.net:3478",
    ]);
  });

  test("carries one http exchange over a real rtc data channel", async () => {
    const downloader = createRtcPeerConnection();
    const uploader = createRtcPeerConnection();

    try {
      const incomingUploaderChannel = waitForIncomingDataChannel(
        uploader,
        RTC_CHANNEL_LABEL,
        RTC_CHANNEL_PROTOCOL,
      );
      const downloaderChannel = downloader.createDataChannel(
        RTC_CHANNEL_LABEL,
        {
          ordered: true,
          protocol: RTC_CHANNEL_PROTOCOL,
        },
      );
      const downloaderChannelOpen =
        waitForRtcDataChannelOpen(downloaderChannel);

      const offer = await downloader.createOffer();
      await downloader.setLocalDescription(offer);
      await uploader.setRemoteDescription({
        sdp: downloader.localDescription?.sdp || "",
        type: "offer",
      });

      const answer = await uploader.createAnswer();
      await uploader.setLocalDescription(answer);
      await downloader.setRemoteDescription({
        sdp: uploader.localDescription?.sdp || "",
        type: "answer",
      });

      const uploaderChannel = await incomingUploaderChannel;
      await Promise.all([
        downloaderChannelOpen,
        waitForRtcDataChannelOpen(uploaderChannel),
      ]);

      const requestPromise = waitForHttpRequest(uploaderChannel);
      const responsePromise = waitForHttpResponse(downloaderChannel, 0);
      const requestText = buildGetRequest(7, "alpha track.txt", 0);

      sendChunks(downloaderChannel, [
        Buffer.from(requestText.slice(0, 20), "utf8"),
        Buffer.from(requestText.slice(20, 44), "utf8"),
        Buffer.from(requestText.slice(44), "utf8"),
      ]);

      const receivedRequest = await requestPromise;
      expect(receivedRequest).toBe(requestText);

      const responseBody = Buffer.from("hello over rtc", "utf8");
      const responseHead = Buffer.from(
        `HTTP/1.1 200 OK\r\nContent-Length: ${responseBody.length}\r\n\r\n`,
        "utf8",
      );
      sendChunks(uploaderChannel, [
        responseHead.subarray(0, 12),
        Buffer.concat([
          responseHead.subarray(12),
          responseBody.subarray(0, 4),
        ]),
        responseBody.subarray(4),
      ]);

      const response = await responsePromise;
      expect(response.finalStart).toBe(0);
      expect(response.headerText.startsWith("HTTP/1.1 200 OK")).toBe(true);
      expect(response.body).toEqual(responseBody);
    } finally {
      await Promise.allSettled([downloader.close(), uploader.close()]);
    }
  }, 30_000);
});
