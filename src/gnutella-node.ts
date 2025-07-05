import path from "path";
import { Protocol, HOUR } from "./const";
import { GnutellaServer } from "./GnutellaServer";
import { IDGenerator } from "./IDGenerator";
import { SimpleFileManager } from "./SimpleFileManager";
import { SettingStore } from "./SettingStore";
import { Context, SharedFile } from "./types";
import { promises as fs } from "fs";
import { GWebCacheClient } from "./cache-client";
import { ConnectionManager } from "./core/ConnectionManager";
import { BootstrapManager } from "./core/BootstrapManager";
import { getPublicIP } from "./utils/network";

export class GnutellaNode {
  private server: GnutellaServer | null;
  private peerStore: SettingStore;
  private fileManager: SimpleFileManager;
  private context: Context | null;
  private gwcClient: GWebCacheClient | null;
  private connectionManager: ConnectionManager | null;
  private bootstrapManager: BootstrapManager | null;

  constructor() {
    this.server = null;
    this.peerStore = new SettingStore();
    this.fileManager = new SimpleFileManager();
    this.context = null;
    this.gwcClient = null;
    this.connectionManager = null;
    this.bootstrapManager = null;
  }

  async start(): Promise<void> {
    const localIp = await getPublicIP();
    const localPort = Protocol.PORT;
    const serventId = IDGenerator.servent();

    this.context = {
      localIp,
      localPort,
      peerStore: this.peerStore,
      fileManager: this.fileManager,
      serventId,
    };

    await this.peerStore.load();
    await this.loadSharedFiles();

    // Initialize server
    this.server = new GnutellaServer(this.context);

    // Initialize GWebCache client
    this.gwcClient = new GWebCacheClient("BUNT", "0.1.0");

    // Initialize connection manager
    this.connectionManager = new ConnectionManager(
      this.server,
      this.peerStore,
      this.gwcClient,
    );

    // Wire up server events to connection manager
    this.server.on("peer:connected", (id, connection) => {
      this.connectionManager?.onPeerConnected(id, connection);
    });

    this.server.on("peer:disconnected", (id) => {
      this.connectionManager?.onPeerDisconnected(id);
    });

    // Start the server
    await this.server.start(localPort);

    // Initialize and run bootstrap manager
    this.bootstrapManager = new BootstrapManager(
      this.server,
      this.peerStore,
      this.gwcClient,
      this.connectionManager,
      localPort,
    );

    await this.bootstrapManager.bootstrap();

    this.setupPeriodicTasks();
    this.setupShutdownHandler();
  }

  private async loadSharedFiles(): Promise<void> {
    const dir = path.join(process.cwd(), "gnutella-library");
    await fs.mkdir(dir, { recursive: true });

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      const parsed = path.parse(entry.name);

      const keywords = new Set<string>();
      keywords.add(entry.name.toLowerCase());

      if (parsed.name) {
        parsed.name
          .split(/[^a-zA-Z0-9]+/)
          .filter(Boolean)
          .forEach((k) => keywords.add(k.toLowerCase()));
      }

      if (parsed.ext) {
        keywords.add(parsed.ext.replace(/^\./, "").toLowerCase());
      }

      this.fileManager.addFile(entry.name, stat.size, Array.from(keywords));
    }
  }

  getSharedFiles(): SharedFile[] {
    return this.fileManager.getFiles();
  }

  sendPush(
    targetServentId: Buffer,
    fileIndex: number,
    requesterPort: number,
  ): void {
    if (!this.server || !this.context) {
      throw new Error("GnutellaNode not started");
    }

    this.server.sendPush(
      targetServentId,
      fileIndex,
      this.context.localIp,
      requesterPort,
    );
  }

  private setupPeriodicTasks(): void {
    setInterval(() => this.peerStore.save(), 60000);
    setInterval(() => this.peerStore.prune(), HOUR);
    // Send regular pings (TTL=7) every 3 seconds for fresh pong cache
    setInterval(() => this.server?.pingPeers(Protocol.TTL), 3 * 1000);
    // Send alive pings (TTL=1) every 30 seconds to keep connections alive
    setInterval(() => this.server?.pingPeers(1), 30 * 1000);
  }

  private setupShutdownHandler(): void {
    process.on("SIGINT", async () => {
      console.log("\nShutting down gracefully...");

      // Stop bootstrap manager
      this.bootstrapManager?.stop();

      // Stop server
      await this.server?.stop();

      // Save peer data
      await this.peerStore.save();

      process.exit(0);
    });
  }
}
