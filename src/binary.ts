export class Binary {
  static readUInt32LE(buffer: Buffer, offset: number): number {
    return buffer.readUInt32LE(offset);
  }

  static writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
    buffer.writeUInt32LE(value, offset);
  }

  static ipToBuffer(ip: string): Buffer {
    const parts = ip.split(".");
    return Buffer.from(parts.map((p) => parseInt(p)));
  }

  static bufferToIp(buffer: Buffer, offset: number): string {
    return Array.from(buffer.slice(offset, offset + 4)).join(".");
  }
}
