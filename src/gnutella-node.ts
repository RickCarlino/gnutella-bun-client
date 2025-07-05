import path from "path";
import { Protocol, HOUR } from "./const";
import { GnutellaServer } from "./GnutellaServer";
import { IDGenerator } from "./IDGenerator";
import { QRPManager } from "./QRPManager";
import { SettingStore } from "./SettingStore";
import { Context, SharedFile } from "./types";
import { promises as fs } from "fs";

export class GnutellaNode {
  private server: GnutellaServer | null;
  private peerStore: SettingStore;
  private qrpManager: QRPManager;
  private context: Context | null;

  constructor() {
    this.server = null;
    this.peerStore = new SettingStore();
    this.qrpManager = new QRPManager();
    this.context = null;
  }

  async start(): Promise<void> {
    const localIp = await this.getPublicIp();
    const localPort = Protocol.PORT;
    const serventId = IDGenerator.servent();

    this.context = {
      localIp,
      localPort,
      peerStore: this.peerStore,
      qrpManager: this.qrpManager,
      serventId,
    };

    await this.peerStore.load();
    await this.loadSharedFiles();

    this.server = new GnutellaServer(this.context);
    await this.server.start(localPort);

    this.setupPeriodicTasks();
    this.setupShutdownHandler();
  }

  private async getPublicIp(): Promise<string> {
    const response = await fetch("https://wtfismyip.com/text");
    return (await response.text()).trim();
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

      this.qrpManager.addFile(entry.name, stat.size, Array.from(keywords));
    }
  }

  getSharedFiles(): SharedFile[] {
    return this.qrpManager.getFiles();
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
      await this.server?.stop();
      await this.peerStore.save();
      process.exit(0);
    });
  }
}
