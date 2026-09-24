import crypto from "node:crypto";
import { TYPE } from "../../const";
import type { DescriptorSuppressionInput } from "./types";

/** Apply duplicate and closing-peer suppression rules. */
export function shouldSuppressDescriptor(
  input: DescriptorSuppressionInput,
): boolean {
  if (
    input.closingAfterBye &&
    input.payloadType !== TYPE.QUERY_HIT &&
    input.payloadType !== TYPE.PUSH
  ) {
    return true;
  }
  if (input.payloadType === TYPE.ROUTE_TABLE_UPDATE) return false;
  return input.alreadySeen;
}

/** Exclude QRP updates from descriptor deduplication. */
export function shouldMarkDescriptorSeen(payloadType: number): boolean {
  return payloadType !== TYPE.ROUTE_TABLE_UPDATE;
}

/** Build a deduplication key, distinguishing response payloads. */
export function seenKey(
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): string {
  const base = `${payloadType}:${descriptorIdHex}`;
  if (
    (payloadType === TYPE.PONG || payloadType === TYPE.QUERY_HIT) &&
    payload
  ) {
    const digest = crypto.createHash("sha1").update(payload).digest("hex");
    return `${base}:${digest}`;
  }
  return base;
}
