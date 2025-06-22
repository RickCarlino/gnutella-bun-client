export class IDGenerator {
  static generate(): Buffer {
    const crypto = require("crypto");
    const id = crypto.randomBytes(16);
    id[8] = 0xff;
    id[15] = 0x00;
    return id;
  }

  static servent(): Buffer {
    return Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  }
}
