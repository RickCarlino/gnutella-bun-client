import { Context } from "./types";

export function buildBaseHeaders(context: Context): Record<string, string> {
  return {
    "User-Agent": "GnutellaBun/0.1",
    "X-Ultrapeer": "False",
    "X-Ultrapeer-Needed": "True", // We're a leaf node, so we need ultrapeers
    "X-Query-Routing": "0.2",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${context.localIp}:${context.localPort}`,
    "Bye-Packet": "0.1",
  };
}
