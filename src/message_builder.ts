import { Protocol, MessageType } from "./constants";
import { Binary } from "./binary";
import { IDGenerator } from "./id_generator";
import { Hash } from "./hash";
import { FakeFile } from "./core_types";

export class MessageBuilder {
  static header(
    type: number,
    payloadLength: number,
    ttl: number = Protocol.TTL,
    id?: Buffer,
  ): Buffer {
    const header = Buffer.alloc(Protocol.HEADER_SIZE);
    const messageId = id || IDGenerator.generate();

    messageId.copy(header, 0);
    header[16] = type;
    header[17] = ttl;
    header[18] = 0;
    Binary.writeUInt32LE(header, payloadLength, 19);

    return header;
  }

  static handshake(startLine: string, headers: Record<string, string>): Buffer {
    const lines = [startLine];

    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`);
    }

    lines.push("", "");
    return Buffer.from(lines.join("\r\n"), "ascii");
  }

  static ping(id?: Buffer, ttl: number = Protocol.TTL): Buffer {
    return this.header(MessageType.PING, 0, ttl, id);
  }

  static pong(
    pingId: Buffer,
    port: number,
    ip: string,
    files: number = 0,
    kb: number = 0,
    ttl: number = Protocol.TTL,
  ): Buffer {
    const payload = Buffer.alloc(Protocol.PONG_SIZE);

    payload.writeUInt16LE(port, 0);
    Binary.ipToBuffer(ip).copy(payload, 2);
    Binary.writeUInt32LE(payload, files, 6);
    Binary.writeUInt32LE(payload, kb, 10);

    return Buffer.concat([
      this.header(MessageType.PONG, Protocol.PONG_SIZE, ttl, pingId),
      payload,
    ]);
  }

  static queryHit(
    queryId: Buffer,
    port: number,
    ip: string,
    files: FakeFile[],
    serventId: Buffer,
  ): Buffer {
    const fileEntries = files.map((file) => this.fileEntry(file));
    const totalFileSize = fileEntries.reduce(
      (sum, entry) => sum + entry.length,
      0,
    );
    const payloadSize = 11 + totalFileSize + Protocol.QUERY_HITS_FOOTER;

    const header = this.header(
      MessageType.QUERY_HITS,
      payloadSize,
      Protocol.TTL,
      queryId,
    );
    const payloadHeader = this.queryHitHeader(files.length, port, ip);
    const vendorCode = this.vendorCode();

    return Buffer.concat([
      header,
      payloadHeader,
      ...fileEntries,
      vendorCode,
      serventId,
    ]);
  }

  private static fileEntry(file: FakeFile): Buffer {
    const nameBuf = Buffer.from(file.filename, "utf8");
    const sha1Urn = file.sha1
      ? Buffer.from(Hash.sha1ToUrn(file.sha1), "utf8")
      : null;
    const entrySize =
      8 + nameBuf.length + 1 + (sha1Urn ? sha1Urn.length + 1 : 1);

    const entry = Buffer.alloc(entrySize);
    let offset = 0;

    Binary.writeUInt32LE(entry, file.index, offset);
    offset += 4;

    Binary.writeUInt32LE(entry, file.size, offset);
    offset += 4;

    nameBuf.copy(entry, offset);
    offset += nameBuf.length;
    entry[offset++] = 0;

    if (sha1Urn) {
      sha1Urn.copy(entry, offset);
      offset += sha1Urn.length;
    }
    entry[offset] = 0;

    return entry;
  }

  private static queryHitHeader(
    fileCount: number,
    port: number,
    ip: string,
  ): Buffer {
    const header = Buffer.alloc(11);

    header[0] = fileCount;
    header.writeUInt16LE(port, 1);
    Binary.ipToBuffer(ip).copy(header, 3);
    Binary.writeUInt32LE(header, 1000, 7);

    return header;
  }

  private static vendorCode(): Buffer {
    const code = Buffer.alloc(7);
    code.write("GBUN", 0, 4, "ascii");
    code[4] = 2;
    code[5] = 0;
    code[6] = 1;
    return code;
  }
}
