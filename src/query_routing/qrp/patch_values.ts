export function encodeSignedPatchValue(
  delta: number,
  bits: number,
): number {
  const signBit = 1 << (bits - 1);
  const min = -signBit;
  const max = signBit - 1;
  if (delta < min || delta > max)
    throw new Error(`QRP ${bits}-bit patch delta out of range ${delta}`);
  return delta & ((1 << bits) - 1);
}

export function applyPresencePatchValue(
  current: number,
  infinity: number,
  encoded: number,
  bits: number,
): number {
  if (encoded === 0) return current;
  const signBit = 1 << (bits - 1);
  return encoded & signBit ? 1 : infinity;
}

export function flipPresencePatchValue(
  current: number,
  infinity: number,
): number {
  return current < infinity ? infinity : 1;
}
