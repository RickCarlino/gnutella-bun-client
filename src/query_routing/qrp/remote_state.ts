import {
  DEFAULT_QRP_ENTRY_BITS,
  DEFAULT_QRP_INFINITY,
  QRP_COMPRESSOR_DEFLATE,
  QRP_COMPRESSOR_NONE,
} from "./constants";
import type {
  QrpPatchMessage,
  QrpResetMessage,
  RemoteQrpState,
} from "./types";

export function initialRemoteQrpState(): RemoteQrpState {
  return {
    resetSeen: false,
    tableSize: 0,
    infinity: DEFAULT_QRP_INFINITY,
    entryBits: DEFAULT_QRP_ENTRY_BITS,
    table: null,
    seqSize: 0,
    compressor: QRP_COMPRESSOR_NONE,
    parts: new Map<number, Buffer>(),
  };
}

export function validateRemoteQrpPatchSequence(
  state: RemoteQrpState,
  msg: QrpPatchMessage,
): string | undefined {
  return (
    validateQrpResetSeen(state) ??
    validateQrpPatchBounds(msg) ??
    validateQrpPatchOrder(state, msg) ??
    validateQrpPatchCodec(msg) ??
    validateQrpPatchStability(state, msg)
  );
}

export function validateRemoteQrpReset(
  msg: QrpResetMessage,
): string | undefined {
  if (!isPowerOfTwo(msg.tableLength))
    return `Invalid QRP table length ${msg.tableLength}`;
  if (msg.infinity < 1) return `Invalid QRP infinity ${msg.infinity}`;
  return undefined;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value));
}

function validateQrpResetSeen(state: RemoteQrpState): string | undefined {
  if (!state.resetSeen) return "No QRP RESET received before PATCH";
  return undefined;
}

function validateQrpPatchBounds(msg: QrpPatchMessage): string | undefined {
  if (msg.seqSize < 1 || msg.seqNo < 1 || msg.seqNo > msg.seqSize)
    return `Invalid QRP seq number ${msg.seqNo} of ${msg.seqSize}`;
  return undefined;
}

function validateQrpPatchOrder(
  state: RemoteQrpState,
  msg: QrpPatchMessage,
): string | undefined {
  const expectedSeqNo = state.seqSize ? state.parts.size + 1 : 1;
  if (msg.seqNo !== expectedSeqNo)
    return `Invalid QRP seq number ${msg.seqNo} (expected ${expectedSeqNo})`;
  if (state.seqSize && msg.seqSize !== state.seqSize)
    return `Changed QRP seq size to ${msg.seqSize} at message #${msg.seqNo} (began with ${state.seqSize})`;
  return undefined;
}

function validateQrpPatchCodec(msg: QrpPatchMessage): string | undefined {
  if (
    msg.compressor !== QRP_COMPRESSOR_NONE &&
    msg.compressor !== QRP_COMPRESSOR_DEFLATE
  )
    return `Invalid QRP compressor ${msg.compressor}`;

  if (![1, 2, 4, 8].includes(msg.entryBits))
    return `Invalid QRP entry bits ${msg.entryBits}`;
  return undefined;
}

function validateQrpPatchStability(
  state: RemoteQrpState,
  msg: QrpPatchMessage,
): string | undefined {
  if (state.seqSize && msg.entryBits !== state.entryBits)
    return `Changed QRP patch entry bits to ${msg.entryBits} at message #${msg.seqNo} (began with ${state.entryBits})`;

  if (state.seqSize && msg.compressor !== state.compressor)
    return `Changed QRP compressor to ${msg.compressor} at message #${msg.seqNo} (began with ${state.compressor})`;

  return undefined;
}
