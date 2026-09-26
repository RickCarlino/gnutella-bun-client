import type { GnutellaEvent } from "./types";

export type MonitorMode = "off" | "all" | "downloads";

/** Check whether the monitor should display an event. */
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
