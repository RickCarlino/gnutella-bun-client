import { describe, test, expect } from "bun:test";
import { generateQrpTable, sendQrpTable, type SharedFile } from "../src/qrp";
import { parseGnutella } from "../src/parser";

describe("QRP", () => {
  test("should generate QRP table from shared files", () => {
    const files: SharedFile[] = [
      { name: "test-file.txt", size: 1024 },
      { name: "another_document.pdf", size: 2048 },
      { name: "music-track-2023.mp3", size: 4096 },
    ];
    
    const table = generateQrpTable(files);
    expect(table).toBeDefined();
    
    // Table should be a BitArray with correct size
    const buffer = table.toBuffer();
    expect(buffer.length).toBe(65536 / 8); // 8192 bytes
  });

  test("should send QRP RESET and PATCH messages", () => {
    const sentMessages: Buffer[] = [];
    const mockSend = (buffer: Buffer) => {
      sentMessages.push(buffer);
    };
    
    const files: SharedFile[] = [
      { name: "test.txt", size: 100 },
    ];
    
    sendQrpTable(mockSend, files);
    
    // Should send exactly 2 messages: RESET then PATCH
    expect(sentMessages.length).toBe(2);
    
    // First message should be RESET
    const reset = parseGnutella(sentMessages[0]);
    expect(reset?.type).toBe("qrp_reset");
    if (reset?.type === "qrp_reset") {
      expect(reset.tableLength).toBe(65536);
      expect(reset.variant).toBe(0);
    }
    
    // Second message should be PATCH
    const patch = parseGnutella(sentMessages[1]);
    expect(patch?.type).toBe("qrp_patch");
    if (patch?.type === "qrp_patch") {
      expect(patch.variant).toBe(1);
      expect(patch.seqNo).toBe(1);
      expect(patch.seqCount).toBe(1);
      expect(patch.compression).toBe(0);
      expect(patch.entryBits).toBe(1);
      expect(patch.data.length).toBe(8192); // 65536 bits / 8
    }
  });

  test("should handle empty file list", () => {
    const sentMessages: Buffer[] = [];
    const mockSend = (buffer: Buffer) => {
      sentMessages.push(buffer);
    };
    
    sendQrpTable(mockSend, []);
    
    expect(sentMessages.length).toBe(2);
    
    // Table should still be sent, just all zeros
    const patch = parseGnutella(sentMessages[1]);
    if (patch?.type === "qrp_patch") {
      // Check that data is all zeros
      const allZeros = patch.data.every(byte => byte === 0);
      expect(allZeros).toBe(true);
    }
  });
});