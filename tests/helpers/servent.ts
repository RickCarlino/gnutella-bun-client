import type { PeerConnections } from "../../src/connections/connections";
import type { LocalAddress } from "../../src/discovery/local_address";
import type { PeerDiscovery } from "../../src/discovery/runtime";
import type { DownloadManager } from "../../src/downloads";
import { GnutellaServent as PublicServent } from "../../src/protocol";
import type { MessageRouter } from "../../src/routing/router";
import type { SearchService } from "../../src/search/service";
import type { ShareLibrary } from "../../src/shares/library";
import type { TransferService } from "../../src/transfers/service";

/** Exposes runtime owners and maintenance hooks to tests. */
export class TestServent extends PublicServent {
  declare readonly connections: PeerConnections;
  declare readonly router: MessageRouter;
  declare readonly transfers: TransferService;
  declare readonly shareLibrary: ShareLibrary;
  declare readonly search: SearchService;
  declare readonly discovery: PeerDiscovery;
  declare readonly localAddress: LocalAddress;
  declare readonly downloadManager: DownloadManager;

  /** Expose recurring maintenance scheduling to tests. */
  override schedule(...args: Parameters<PublicServent["schedule"]>): void {
    super.schedule(...args);
  }
  /** Expose expiration cleanup to tests. */
  override pruneMaps(): void {
    super.pruneMaps();
  }
  /** Read the test node's injected clock. */
  override now(): number {
    return super.now();
  }
  /** Expose maintenance error reporting to tests. */
  override emitMaintenanceError(
    ...args: Parameters<PublicServent["emitMaintenanceError"]>
  ): void {
    super.emitMaintenanceError(...args);
  }
}
