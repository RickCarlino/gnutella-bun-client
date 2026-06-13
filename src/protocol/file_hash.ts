import crypto from "node:crypto";
import fs from "node:fs";

export async function sha1File(abs: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const rs = fs.createReadStream(abs);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(hash.digest()));
  });
}
