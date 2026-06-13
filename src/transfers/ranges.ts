type ByteRange = {
  start: number;
  end: number;
  partial: boolean;
};

function parseByteRangeSuffix(
  endRaw: string,
  size: number,
  last: number,
): ByteRange | null {
  const suffixLen = Number(endRaw);
  if (!Number.isInteger(suffixLen) || suffixLen <= 0) return null;
  const length = Math.min(suffixLen, size);
  return { start: size - length, end: last, partial: length < size };
}

function explicitByteRangeEnd(
  endRaw: string,
  start: number,
  size: number,
  last: number,
): number | undefined {
  const end = endRaw ? Number(endRaw) : last;
  if (!Number.isInteger(end) || end < start) return undefined;
  if (size === 0) return -1;
  return Math.min(end, last);
}

function parseByteRangeExplicit(
  startRaw: string,
  endRaw: string,
  size: number,
  last: number,
): ByteRange | null {
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return null;
  if (size > 0 && start > last) return null;
  const end = explicitByteRangeEnd(endRaw, start, size, last);
  if (end == null) return null;
  return { start, end, partial: size > 0 && (start > 0 || end < last) };
}

export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): ByteRange | null {
  const last = size > 0 ? size - 1 : -1;
  if (!rangeHeader) return { start: 0, end: last, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (!startRaw && !endRaw) return null;
  if (!startRaw) return parseByteRangeSuffix(endRaw, size, last);
  return parseByteRangeExplicit(startRaw, endRaw, size, last);
}
