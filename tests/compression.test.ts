import { describe, test, expect } from "bun:test";
import { createDeflate, createInflate } from "node:zlib";
import { parseGnutella } from "../src/parser";

describe("Compression", () => {
  test("should compress and decompress Gnutella messages", async () => {
    // Create a ping message
    const ping = Buffer.from([
      // Descriptor ID (16 bytes)
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0xff, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x00,
      // Payload descriptor (1 byte) - 0x00 for ping
      0x00,
      // TTL (1 byte)
      0x07,
      // Hops (1 byte)
      0x00,
      // Payload length (4 bytes, little-endian) - 0 for ping
      0x00, 0x00, 0x00, 0x00
    ]);

    // Compress the message
    const deflator = createDeflate();
    const inflator = createInflate();
    
    const compressed: Buffer[] = [];
    const decompressed: Buffer[] = [];
    
    deflator.on("data", (chunk) => compressed.push(chunk));
    inflator.on("data", (chunk) => decompressed.push(chunk));
    
    // Compress
    deflator.write(ping);
    deflator.end();
    
    // Wait for compression to complete
    await new Promise(resolve => deflator.on("end", resolve));
    
    const compressedData = Buffer.concat(compressed);
    expect(compressedData.length).toBeGreaterThan(0);
    expect(compressedData.length).toBeLessThan(ping.length + 10); // Should be close in size for small messages
    
    // Decompress
    inflator.write(compressedData);
    inflator.end();
    
    // Wait for decompression to complete
    await new Promise(resolve => inflator.on("end", resolve));
    
    const decompressedData = Buffer.concat(decompressed);
    expect(decompressedData).toEqual(ping);
    
    // Verify the decompressed message can be parsed
    const parsed = parseGnutella(decompressedData);
    expect(parsed?.type).toBe("ping");
  });

  test("should handle continuous stream compression", async () => {
    const deflator = createDeflate();
    const inflator = createInflate();
    
    const messages: Buffer[] = [];
    const decompressed: Buffer[] = [];
    
    inflator.on("data", (chunk) => decompressed.push(chunk));
    
    // Pipe deflator to inflator to simulate network
    deflator.pipe(inflator);
    
    // Create multiple ping messages
    for (let i = 0; i < 3; i++) {
      const ping = Buffer.from([
        // Descriptor ID (16 bytes) - varying first byte
        i + 1, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0xff, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x00,
        // Payload descriptor (1 byte) - 0x00 for ping
        0x00,
        // TTL (1 byte)
        0x07,
        // Hops (1 byte)
        0x00,
        // Payload length (4 bytes, little-endian) - 0 for ping
        0x00, 0x00, 0x00, 0x00
      ]);
      messages.push(ping);
      deflator.write(ping);
      deflator.flush(); // Flush to ensure timely delivery
    }
    
    // Wait a bit for data to flow through
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const decompressedData = Buffer.concat(decompressed);
    const expectedData = Buffer.concat(messages);
    
    expect(decompressedData.length).toBe(expectedData.length);
    expect(decompressedData).toEqual(expectedData);
  });
});