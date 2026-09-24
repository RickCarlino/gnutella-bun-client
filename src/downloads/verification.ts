import { sha1File } from "../shares/hash_file";
import { sha1BufferFromUrn } from "../wire/content_urn";

/** Compare a file's SHA1 digest with its expected URN. */
export async function verifySha1Urn(
  filePath: string,
  sha1Urn: string,
): Promise<boolean> {
  const expected = sha1BufferFromUrn(sha1Urn);
  if (!expected) throw new Error("invalid SHA1 URN");
  const actual = await sha1File(filePath);
  return expected.equals(actual);
}
