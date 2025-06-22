import { describe, test, expect } from "bun:test";
import { MessageBuilder } from "./message_builder";
import { MessageParser } from "./message_parser";
import { IDGenerator } from "./id_generator";
import { Hash } from "./hash";
import { PongMessage, QueryHitsMessage } from "./core_types";

describe("MessageBuilder", () => {
  test("handshake", () => {
    const buf = MessageBuilder.handshake("GNUTELLA CONNECT/0.6", {
      Foo: "Bar",
    });
    const parsed =
      MessageParser.parse(buf) as import("./core_types").HandshakeConnectMessage;
    expect(parsed.type).toBe("handshake_connect");
    expect(parsed.headers.Foo).toBe("Bar");
  });

  test("ping and pong", () => {
    const ping = MessageBuilder.ping();
    const pingMsg = MessageParser.parse(ping)!;
    expect(pingMsg.type).toBe("ping");
    const pong = MessageBuilder.pong(
      pingMsg.header!.descriptorId,
      1234,
      "1.2.3.4",
    );
    const pongMsg = MessageParser.parse(pong) as PongMessage;
    expect(pongMsg.type).toBe("pong");
    expect(pongMsg.port).toBe(1234);
    expect(pongMsg.ipAddress).toBe("1.2.3.4");
  });

  test("query hit", () => {
    const sha = Hash.sha1("data");
    const buf = MessageBuilder.queryHit(
      IDGenerator.generate(),
      1111,
      "1.1.1.1",
      [
        {
          filename: "file.txt",
          size: 1,
          index: 1,
          sha1: sha,
          keywords: ["file"],
        },
      ],
      IDGenerator.servent(),
    );
    const msg = MessageParser.parse(buf) as QueryHitsMessage;
    expect(msg.type).toBe("query_hits");
    expect(msg.numberOfHits).toBe(1);
    expect(msg.port).toBe(1111);
  });
});
