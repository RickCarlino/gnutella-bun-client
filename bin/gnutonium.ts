#!/usr/bin/env bun

import process from "node:process";
import { main as modernMain } from "../src/cli";
import { errMsg } from "../src/cli_shared";

async function main() {
  await modernMain(process.argv.slice(2));
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
