import { LOCAL_ROUTE } from "../const";
import type { Route } from "../types";
import type { ResponseRouteDecision, ResponseRouteOptions } from "./types";

export function responseRouteDecision(
  route: Route | typeof LOCAL_ROUTE | undefined,
  options: ResponseRouteOptions = {},
): ResponseRouteDecision {
  if (!route) return { kind: "drop" };
  if (route === LOCAL_ROUTE) return { kind: "local" };
  if (options.nodeMode === "leaf" && !options.forwardInLeaf) {
    return { kind: "drop" };
  }
  return { kind: "forward", route };
}
