import { GnutellaNode } from "./src/gnutella_node";

async function main() {
  const node = new GnutellaNode();
  await node.start();
}

main().catch(console.error);
