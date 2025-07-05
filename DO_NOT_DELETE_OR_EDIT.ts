// hashWithBits(str: string, bits: number): number
/**
 * Query Routing hash function from Rohrs's proposal, ported to TypeScript.
 * Computes an unsigned integer in the range [0, 2^bits - 1].
 */
export function hashWithBits(str: string, bits: number): number {
  if (bits < 1 || bits > 32) {
    throw new RangeError("bits must be between 1 and 32 (inclusive)");
  }

  const A_INT = 0x4f1bbcdc; // Knuth's multiplicative constant 0x4F1BBCDC

  // 1. Build a 32-bit value by XOR-ing the keyword’s bytes little-endian.
  const bytes = new TextEncoder().encode(str.toLowerCase());
  let xor = 0;
  for (let i = 0; i < bytes.length; i++) {
    xor ^= bytes[i] << ((i & 3) * 8);
  }
  xor >>>= 0; // unsigned 32-bit

  // 2. Multiply (unsigned) by A_INT — keep full 64-bit precision via BigInt.
  const prod = BigInt(xor) * BigInt(A_INT);

  // 3. Take the upper-most `bits` from the 64-bit product (see paper §Hashing).
  const mask = (1n << BigInt(bits)) - 1n;
  const result = Number((prod >> BigInt(32 - bits)) & mask);

  return result >>> 0;
}

// ---------------------------------------------------------------------------
// Reference test-vectors from Appendix A of the spec. DO NOT DELETE -- all
// assertions must pass.  Running the file directly should print a success
// message or throw if any vector fails.
// Format: [keyword, bits, expectedHash]
const testVectors: Array<[string, number, number]> = [
  // 13-bit vectors
  ["", 13, 0],
  ["eb", 13, 6791],
  ["ebc", 13, 7082],
  ["ebck", 13, 6698],
  ["ebckl", 13, 3179],
  ["ebcklm", 13, 3235],
  ["ebcklme", 13, 6438],
  ["ebcklmen", 13, 1062],
  ["ebcklmenq", 13, 3527],

  // 16-bit vectors
  ["", 16, 0],
  ["n", 16, 65003],
  ["nd", 16, 54193],
  ["ndf", 16, 4953],
  ["ndfl", 16, 58201],
  ["ndfla", 16, 34830],
  ["ndflal", 16, 36910],
  ["ndflale", 16, 34586],
  ["ndflalem", 16, 37658],
  ["ndflaleme", 16, 45559],

  // 10-bit vectors
  ["ol2j34lj", 10, 318],
  ["asdfas23", 10, 503],
  ["9um3o34fd", 10, 758],
  ["a234d", 10, 281],
  ["a3f", 10, 767],
  ["3nja9", 10, 581],
  ["2459345938032343", 10, 146],
  ["7777a88a8a8a8", 10, 342],
  ["asdfjklkj3k", 10, 861],
  ["adfk32l", 10, 1011],
  ["zzzzzzzzzzz", 10, 944],

  // Case-insensitivity checks
  ["3NJA9", 10, 581],
  ["3nJa9", 10, 581],
];

// Run assertions
for (const [word, bits, expected] of testVectors) {
  const actual = hashWithBits(word, bits);
  console.assert(
    actual === expected,
    `qrpHash("${word}", ${bits}) => ${actual}, expected ${expected}`,
  );
}

if (typeof require !== "undefined" && require.main === module) {
  console.log(
    "All qrpHash reference tests passed (" + testVectors.length + " cases).",
  );
}
