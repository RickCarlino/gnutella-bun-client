import { Protocol } from "./src/constants";
import { GnutellaNode } from "./src/gnutella_node";

async function main() {
  const node = new GnutellaNode();
  console.log(`Node is running on port ${Protocol.PORT}`);
  console.log(
    JSON.stringify(
      {
        ...node,
        qrpManager: undefined, // Exclude qrpManager from the output
      },
      null,
      2,
    ),
  );
  await node.start();
}

main().catch(console.error);
