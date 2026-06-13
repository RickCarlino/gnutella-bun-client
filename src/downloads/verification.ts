import { sha1BufferFromUrn } from "../protocol/content_urn";
import { sha1File } from "../protocol/file_hash";

export async function verifySha1Urn(
  filePath: string,
  sha1Urn: string,
): Promise<boolean> {
  const expected = sha1BufferFromUrn(sha1Urn);
  if (!expected) throw new Error("invalid SHA1 URN");
  const actual = await sha1File(filePath);
  return expected.equals(actual);
}
