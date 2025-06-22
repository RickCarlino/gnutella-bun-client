import { describe, test, expect } from "bun:test";
import { MessageParser } from "./message_parser";
import { MessageBuilder } from "./message_builder";
import { QRPManager } from "./qrp_manager";

describe("MessageParser", () => {
  test("parses handshake connect", () => {
    const buf = MessageBuilder.handshake("GNUTELLA CONNECT/0.6", { Foo: "Bar" });
    const msg = MessageParser.parse(buf)!;
    expect(msg.type).toBe("handshake_connect");
    expect((msg as any).headers.Foo).toBe("Bar");
    expect(MessageParser.getMessageSize(msg, buf)).toBe(buf.length);
  });

  test("parses ping", () => {
    const ping = MessageBuilder.ping();
    const msg = MessageParser.parse(ping)!;
    expect(msg.type).toBe("ping");
    expect(MessageParser.getMessageSize(msg, ping)).toBe(ping.length);
  });

  test("parses pong", () => {
    const ping = MessageBuilder.ping();
    const pong = MessageBuilder.pong(MessageParser.parse(ping)!.header.descriptorId, 1234, "1.2.3.4");
    const msg = MessageParser.parse(pong)!;
    expect(msg.type).toBe("pong");
    expect(msg.port).toBe(1234);
    expect(MessageParser.getMessageSize(msg, pong)).toBe(pong.length);
  });

  test("parses route table reset", () => {
    const buf = new QRPManager(32, 7).buildResetMessage();
    const msg = MessageParser.parse(buf)!;
    expect(msg.type).toBe("route_table_update");
    expect((msg as any).variant).toBe("reset");
  });
});
