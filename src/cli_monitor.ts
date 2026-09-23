import type { GnutellaEvent } from "./types";

export type MonitorMode = "off" | "all" | "downloads";

export function selectMonitorMode(
  args: string[],
  current: MonitorMode,
): MonitorMode {
  if (args.length === 0) return current === "off" ? "all" : "off";
  if (args.length === 1) {
    switch (args[0].toLowerCase()) {
      case "on":
      case "all":
        return "all";
      case "off":
        return "off";
      case "downloads":
        return "downloads";
    }
  }
  throw new Error("usage: monitor [on|off|all|downloads]");
}

export function monitorAllowsEvent(
  mode: MonitorMode,
  event: GnutellaEvent,
): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return (
    event.type.startsWith("DOWNLOAD_") ||
    (event.type === "MAINTENANCE_ERROR" &&
      event.operation === "DOWNLOAD_MANAGER")
  );
}
