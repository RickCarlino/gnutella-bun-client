import process from "node:process";

import { errMsg } from "../src/cli_shared";
import { main as modernMain } from "../src/cli";

async function main() {
  await modernMain(process.argv.slice(2));
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
