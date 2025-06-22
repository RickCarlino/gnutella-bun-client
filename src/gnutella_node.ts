import { Protocol } from "./constants";
import { GnutellaServer } from "./gnutella_server";
import { PeerStore } from "./peer_store";
import { QRPManager } from "./qrp_manager";
import { IDGenerator } from "./id_generator";
import { NodeContext } from "./core_types";
import { promises as fs } from "fs";
import path from "path";

export class GnutellaNode {
  private server: GnutellaServer | null = null;
  private peerStore: PeerStore;
  private qrpManager: QRPManager;
  private context: NodeContext | null = null;

  constructor() {
    this.peerStore = new PeerStore();
    this.qrpManager = new QRPManager();
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

  async loadSharedFiles(): Promise<void> {
    const dir = path.join(process.cwd(), "gnutella-library");
    await fs.mkdir(dir, { recursive: true });

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

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

  getSharedFiles(): ReturnType<QRPManager["getFiles"]> {
    return this.qrpManager.getFiles();
  }

  private setupPeriodicTasks(): void {
    const server = this.server;
    setInterval(() => this.peerStore.save(), 60000);
    setInterval(() => this.peerStore.prune(), 3600000);
    setTimeout(() => {
      const host = "127.0.0.1";
      const port = "57713";
      console.log(`Attempting to connect to peer ${host}:${port}`);
      server
        ?.connectPeer(host, parseInt(port, 10))
        .then((_conn) => {
          console.log(`Connected to peer ${host}:${port}`);
        })
        .catch((err) => {
          console.error(`Failed to connect to peer ${host}:${port}`, err);
        });
    }, 5000);
  }

  private setupShutdownHandler(): void {
    process.on("SIGINT", async () => {
      await this.server?.stop();
      await this.peerStore.save();
      process.exit(0);
    });
  }
}
