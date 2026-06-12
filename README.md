# GnutellaBun

GnutellaBun is a small Bun-based Gnutella client you can run from the terminal or embed in a TypeScript app.

It is built for people who want to:

- share files from one folder
- search the Gnutella network
- inspect results before downloading
- browse another peer's shared library
- keep useful state across restarts

It can be used in three ways:

- as an interactive CLI
- as a scripted CLI runner
- as a library inside another app

It interoperates with other Gnutella clients, including GTK Gnutella.

## Prebuilt Binaries

- [Windows](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64.exe)
- [Windows (older CPUs)](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64-baseline.exe)
- [macOS Intel](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-x64)
- [macOS Apple Silicon](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-arm64)
- [Linux builds](https://github.com/RickCarlino/gnutella-bun-client/releases)
- [All releases](https://github.com/RickCarlino/gnutella-bun-client/releases)

Download a prebuilt executable from the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases).

After downloading, run the executable directly:

```bash
./gnutella-bun-linux-x64 init --config gnutella.json
./gnutella-bun-linux-x64 run --config gnutella.json
```

## From Source

If you want to run from source:

```bash
bun install
bun run bin/gnutella.ts init --config gnutella.json
bun run bin/gnutella.ts run --config gnutella.json
```

## Library Use

**NOTE:** Node support is not done. Use Bun.

When used from this repository, the public TypeScript import is:

```ts
import { GnutellaServent, loadDoc } from "gnutella";

const configPath = "./gnutella.json";
const doc = await loadDoc(configPath);
const node = new GnutellaServent(configPath, doc);

await node.start();
node.sendQuery("hello world");
```

## Guides

- [Quickstart](QUICKSTART.md): get the CLI working in a few minutes
- [CLI Guide](CLI.md): full command and config reference
- [Developer Guide](DEVELOPER.md): embed GnutellaBun in your own TypeScript app

## License

GnutellaBun is released under the GNU General Public License v3.0. See [LICENSE](LICENSE).
