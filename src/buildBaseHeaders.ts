import { Context } from "./types";

export function buildBaseHeaders(context: Context): Record<string, string> {
  return {
    "User-Agent": "GnutellaBun/0.1",
    "X-Ultrapeer": "False",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${context.localIp}:${context.localPort}`,
    "Bye-Packet": "0.1",
  };
}
