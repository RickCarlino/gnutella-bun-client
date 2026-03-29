import net from "node:net";

import { TYPE } from "../const";
import { buildHeader, encodeQueryHit } from "./codec";
import { socketCanEnd } from "./handshake";
import type { GnutellaServent } from "./node";
import type { ExistingGetRequest } from "./node_types";

const BROWSE_HOST_ACCEPT = "application/x-gnutella-packets";
const BROWSE_HOST_DESCRIPTOR_ID = Buffer.alloc(16, 0);
const BROWSE_HOST_BATCH_SIZE = 16;

function acceptsBrowseHostQhits(request: ExistingGetRequest): boolean {
  const accept = request.headers["accept"];
  if (!accept) return false;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === BROWSE_HOST_ACCEPT;
  });
}

function buildBrowseHostResponse(
  statusLine: string,
  extraHeaders: string[] = [],
): string {
  return [
    statusLine,
    "Server: Gnutella",
    ...extraHeaders,
    "X-Features: browse/1.0",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

function buildBrowseHostBody(node: GnutellaServent): Buffer {
  const packets: Buffer[] = [];
  for (
    let offset = 0;
    offset < node.shares.length;
    offset += BROWSE_HOST_BATCH_SIZE
  ) {
    const batch = node.shares.slice(
      offset,
      offset + BROWSE_HOST_BATCH_SIZE,
    );
    const payload = encodeQueryHit(
      node.currentAdvertisedPort(),
      node.currentAdvertisedHost(),
      node.config().advertisedSpeedKBps,
      batch,
      node.serventId,
      {
        vendorCode: node.config().vendorCode,
        busy: false,
        haveUploaded: false,
        measuredSpeed: true,
        push: false,
        ggepHashes: !!node.config().enableGgep,
        browseHost: !!node.config().enableGgep,
      },
    );
    packets.push(
      buildHeader(
        BROWSE_HOST_DESCRIPTOR_ID,
        TYPE.QUERY_HIT,
        0,
        0,
        payload,
      ),
    );
  }
  return Buffer.concat(packets);
}

export function isBrowseHostGetRequest(head: string): boolean {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0] || "";
  return /^(GET|HEAD)\s+\/\s+HTTP\/(\d+\.\d+)$/i.test(first);
}

export async function handleBrowseHostGet(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
): Promise<boolean> {
  const request = node.parseExistingGetRequest(head);
  if (!acceptsBrowseHostQhits(request)) {
    socket.write(
      buildBrowseHostResponse("HTTP/1.1 406 Not Acceptable", [
        "Content-Length: 0",
      ]),
    );
    if (socketCanEnd(socket)) socket.end();
    return false;
  }

  socket.write(
    buildBrowseHostResponse(`${request.responseVersion} 200 OK`, [
      `Content-Type: ${BROWSE_HOST_ACCEPT}`,
    ]),
  );
  if (request.method !== "HEAD") {
    socket.write(buildBrowseHostBody(node));
  }
  if (socketCanEnd(socket)) socket.end();
  return false;
}
