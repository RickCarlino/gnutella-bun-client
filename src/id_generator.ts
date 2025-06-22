export class IDGenerator {
  static generate(): Buffer {
    const crypto = require("crypto");
    const id = crypto.randomBytes(16);
    id[8] = 0xff;
    id[15] = 0x00;
    return id;
  }

  static servent(): Buffer {
    return this.generate();
  }
}
