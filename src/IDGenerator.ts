import { randomBytes } from "crypto";

export class IDGenerator {
  static generate(): Buffer {
    const id = randomBytes(16);
    id[8] = 255;
    id[15] = 0;
    return id;
  }

  static servent(): Buffer {
    return this.generate();
  }
}
