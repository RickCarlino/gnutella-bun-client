import net from "net";
import { randomBytes } from "crypto";
import { Desc, DEFAULT_TTL, DESC_LABELS, HELLO, OK } from "./constants";

const GUID = () => randomBytes(16);

function buildPing(): Buffer {
  const buf = Buffer.alloc(23);
  GUID().copy(buf, 0); // 16-byte GUID
  buf[16] = Desc.PING; // descriptor: PING
  buf[17] = DEFAULT_TTL; // TTL
  buf[18] = 0; // hops
  buf.writeUInt32LE(0, 19); // payload length = 0
  return buf;
}

function descriptorName(id: number) {
  return DESC_LABELS[id as Desc] ?? `0x${id.toString(16)}`;
}

function send(sock: net.Socket, data: string | Buffer) {
  console.log(data instanceof Buffer ? data : JSON.stringify(data));
  sock.write(data);
}

function handleMsg(hdr: Buffer, payload: Buffer) {
  const d = hdr[16];
  const name = descriptorName(d);
  console.log(`← ${name} TTL=${hdr[17]} Hops=${hdr[18]} Len=${payload.length}`);

  if (d === Desc.PING && payload.length >= 14) {
    // PONG payload: [port(2)][IP(4)][files(4)][kB(4)]…
    const port = payload.readUInt16BE(0);
    const ip = [...payload.subarray(2, 6)].join(".");
    console.log(`  PONG from ${ip}:${port}`);
  }
}

export function gnutellaPeer(host: string, port: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      let handshaken = false;
      let leftover: Buffer | null = null;
      sock.on("data", (chunk: Buffer) => {
        const message = chunk.toString("utf8");
        console.log(message);
        if (!handshaken) {
          if (message.includes("200 OK")) {
            send(sock, OK);
            handshaken = true;
            resolve(sock);
            send(sock, buildPing());
          } else {
            console.error("Handshake failure");
            reject(new Error("Handshake failure"));
            sock.end();
          }
          return;
        }

        let buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
        while (buf.length >= 23) {
          const len = buf.readUInt32LE(19);
          const total = 23 + len;
          if (buf.length < total) {
            console.log(`… need ${total - buf.length} more bytes`);
            break;
          } // wait for remainder
          const hdr = buf.subarray(0, 23);
          const payload = buf.subarray(23, total);
          handleMsg(hdr, payload);
          buf = buf.subarray(total);
        }
        leftover = buf.length ? buf : null;
      });
      sock.on("close", () => console.log("connection closed"));
      sock.on("error", (e) => reject(e));

      send(sock, HELLO);
    });
  });
}
