import { Protocol } from "./constants";
import { GnutellaServer } from "./gnutella_server";
import { PeerStore } from "./peer_store";
import { QRPManager } from "./qrp_manager";
import { IDGenerator } from "./id_generator";
import { NodeContext } from "./context";

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
    this.setupFakeFiles();

    this.server = new GnutellaServer(this.context);
    await this.server.start(localPort);

    this.setupPeriodicTasks();
    this.setupShutdownHandler();
  }

  private async getPublicIp(): Promise<string> {
    const response = await fetch("https://wtfismyip.com/text");
    return (await response.text()).trim();
  }

  private setupFakeFiles(): void {
    this.qrpManager.addFile("01jyasqdtf0rq0q6wh2ns90ems.mp3", 5000000, [
      "01jyasqdtf0rq0q6wh2ns90ems",
      "mp3",
    ]);

    this.qrpManager.addFile("music.mp3", 3000000, ["music", "song", "mp3"]);

    this.qrpManager.addFile("movie.avi", 700000000, [
      "movie",
      "film",
      "video",
      "avi",
    ]);
  }

  private setupPeriodicTasks(): void {
    setInterval(() => this.peerStore.save(), 60000);
    setInterval(() => this.peerStore.prune(), 3600000);
  }

  private setupShutdownHandler(): void {
    process.on("SIGINT", async () => {
      await this.server?.stop();
      await this.peerStore.save();
      process.exit(0);
    });
  }
}
