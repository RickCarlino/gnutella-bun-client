import os from "os";
import { startConnection } from "./gnutella-connection";
import {
  createHandshakeConnect,
  createHandshakeOk,
  createPong,
  GnutellaObject,
} from "./parser";

const SEEDS: string[] = [
  // "find peers with `bun cache-client.ts`"
];

const CHECK_URL = "https://wtfismyip.com/text";
const localIp = async () =>
  await fetch(CHECK_URL)
    .then((res) => res.text())
    .then((ip) => ip.trim());

const LOCAL_IP = await localIp();
const LOCAL_PORT = 6346;

type Session = { handshake: boolean; version?: string };
const sessions = new Map<string, Session>();

const HEADERS = {
  "User-Agent": "GnutellaBun/0.1",
  "X-Ultrapeer": "False",
  // "Accept-Encoding": "deflate",
};

const shuffle = <T>(a: T[]) =>
  a
    .map((v) => [v, Math.random()] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([v]) => v);

const connect = async (addr: string) => {
  const [ip, port] = addr.split(":");
  console.log(addr);
  try {
    await startConnection({
      ip,
      port: +port,
      onMessage: (send, msg) => handle(addr, send, msg),
      onError: (_, e) => {
        console.error(`Error ${addr}:`, e.message);
        sessions.delete(addr);
      },
      onClose: () => {
        console.log(`Closed ${addr}`);
        sessions.delete(addr);
      },
    }).then((sock) => {
      sessions.set(addr, { handshake: false });
      sock.write(createHandshakeConnect(HEADERS));
    });
  } catch (e) {
    console.error(`Connect fail ${addr}:`, e);
  }
};

const handle = (addr: string, send: (b: Buffer) => void, m: GnutellaObject) => {
  const s = sessions.get(addr);
  if (!s) return;

  const alt = (h?: string) =>
    h
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean) ?? [];

  switch (m.type) {
    case "handshake_connect":
      send(createHandshakeOk(HEADERS));
      break;

    case "handshake_ok":
      s.handshake = true;
      s.version = m.version;
      break;

    case "handshake_error":
      ["X-Try", "X-Try-Ultrapeers", "X-Try-Hubs"].forEach((h) =>
        alt(m.headers?.[h]).forEach((p) => {
          const host = h === "X-Try-Hubs" ? p.split(" ")[0] : p;
          if (!sessions.has(host)) connect(host);
        })
      );
      sessions.delete(addr);
      break;

    case "ping":
      if (s.handshake)
        send(
          createPong(
            m.header.descriptorId,
            LOCAL_PORT,
            LOCAL_IP,
            0,
            0,
            m.header.ttl
          )
        );
      break;

    case "pong":
      console.log(`${addr} pong ${m.ipAddress}:${m.port}`);
      break;

    case "query":
      console.log(`${addr} query "${m.searchCriteria}"`);
      break;

    case "queryhits":
      console.log(`${addr} ${m.numberOfHits} hits`);
      break;

    case "push":
      console.log(`${addr} push`);
      break;

    case "bye":
      console.log(`${addr} bye ${m.code} ${m.message}`);
      break;
  }
};

console.log(`Gnutella ${LOCAL_IP}:${LOCAL_PORT}`);
shuffle(SEEDS).forEach(connect);

setInterval(() => {
  console.log(`Connections ${sessions.size}`);
  sessions.forEach((v, p) =>
    console.log(
      v.handshake ? `✓ ${p} (v${v.version})` : `… ${p} (handshake pending)`
    )
  );
}, 5_000);
