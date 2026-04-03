# Developer Guide

Use this guide if you want to run GBun inside your own TypeScript app instead of driving it through the CLI.

Most apps only need three things:

- `loadDoc()` to load or create a config file
- `GnutellaServent` to run the node
- the public getters and actions on the node instance

## Basic Example

```ts
import { GnutellaServent, loadDoc } from "./src/protocol";
import type { GnutellaEvent } from "./src/types";

const configPath = "./gnutella.json";
const doc = await loadDoc(configPath);

const node = new GnutellaServent(configPath, doc, {
  onEvent(event: GnutellaEvent) {
    if (event.type === "QUERY_RESULT") {
      console.log(
        `#${event.hit.resultNo} ${event.hit.fileName} from ${event.hit.remoteHost}:${event.hit.remotePort}`,
      );
    }

    if (event.type === "DOWNLOAD_SUCCEEDED") {
      console.log("downloaded to", event.destPath);
    }
  },
});

await node.start();
await node.connectToPeer("203.0.113.10:6346");
node.sendQuery("hello world");
```

When you are done:

```ts
await node.save();
await node.stop();
```

## Loading And Saving State

```ts
import { loadDoc } from "./src/protocol";

const doc = await loadDoc("./gnutella.json");
```

`loadDoc()` creates a default config if the file does not exist yet.

The config file uses the same settings as the CLI, so anything you learn in [CLI.md](CLI.md) also applies here.

Call `node.save()` when you want to persist remembered peers, blocked IPs, and other changes immediately.

## Starting A Node

```ts
const node = new GnutellaServent("./gnutella.json", doc);
await node.start();
```

`start()` loads shares, starts listening, and begins normal background work such as peer reconnects.

Call `stop()` for a clean shutdown:

```ts
await node.stop();
```

## Listening For Events

You can subscribe in the constructor with `onEvent`, or later with `subscribe()`.

Useful events for most apps:

- `QUERY_RESULT`: a search hit arrived
- `DOWNLOAD_SUCCEEDED`: a download finished
- `PEER_CONNECTED`: a peer connected
- `PEER_DROPPED`: a peer disconnected
- `SHARES_REFRESHED`: the share list changed
- `MAINTENANCE_ERROR`: background work failed

## Common Node Actions

### Connect To A Peer

```ts
await node.connectToPeer("203.0.113.10:6346");
```

### Search

```ts
node.sendQuery("ambient techno");
```

Then read the result list:

```ts
const results = node.getResults();
```

### Browse A Peer

Browse a connected peer by key:

```ts
await node.browsePeer("p1");
```

Or browse directly by address:

```ts
await node.browsePeer("203.0.113.10:6346");
```

Browse results are added to the normal result list returned by `getResults()`.

### Download A Result

```ts
await node.downloadResult(1);
```

Or choose the destination path yourself:

```ts
await node.downloadResult(1, "./downloads/example.bin");
```

### Refresh Shared Files

```ts
await node.refreshShares();
```

Use this after your app adds or removes files from the shared downloads folder.

## Reading Runtime State

These getters are the ones most apps care about:

- `getStatus()`: summary counts
- `getPeers()`: connected peers
- `getKnownPeers()`: remembered peer addresses
- `getShares()`: local shared files
- `getResults()`: current result list
- `getDownloads()`: completed downloads

Example:

```ts
const status = node.getStatus();
const peers = node.getPeers();
const results = node.getResults();
```

## Runtime Overrides

If you want to change behavior at startup without editing the JSON file first, pass `runtimeConfig` to the constructor:

```ts
const node = new GnutellaServent(configPath, doc, {
  runtimeConfig: {
    ultrapeer: true,
    gwebCacheUrls: ["http://127.0.0.1:6346/gwc.php"],
  },
});
```

This is useful when you want one app-specific setup while still keeping the same saved config format.

## A Good Default Pattern

For most embedding cases, this flow works well:

1. `loadDoc()`
2. `new GnutellaServent(...)`
3. attach an event listener
4. `start()`
5. `connectToPeer(...)` or rely on remembered peers
6. `sendQuery(...)` or `browsePeer(...)`
7. inspect `getResults()`
8. `downloadResult(...)` when needed
9. `save()` and `stop()` on shutdown

## Next Step

If you are mainly using the terminal, read [CLI.md](CLI.md) instead.
