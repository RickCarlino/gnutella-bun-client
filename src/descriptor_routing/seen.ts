import { TYPE } from "../const";
import type { DescriptorSuppressionInput } from "./types";

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

export function shouldMarkDescriptorSeen(payloadType: number): boolean {
  return payloadType !== TYPE.ROUTE_TABLE_UPDATE;
}
