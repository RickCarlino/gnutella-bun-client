# Developer Guide

Use this guide if you want to run Gnutonium inside your own TypeScript app instead of driving it through the CLI.

Install with `npm install gnutonium` and run your app with Bun 1.4.2 or newer.

Most apps only need three things:

- `loadDoc()` to load or create a config file
- `GnutellaServent` to run the node
- the public getters and actions on the node instance

## Basic Example

```ts
import { GnutellaServent, loadDoc, type GnutellaEvent } from "gnutonium";

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
import { loadDoc } from "gnutonium";

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
- `DOWNLOAD_QUEUED`: a managed download job was created or updated
- `DOWNLOAD_STARTED`: a managed download started transferring
- `DOWNLOAD_SUCCEEDED`: a download finished
- `DOWNLOAD_FAILED`: a managed download exhausted its sources
- `DOWNLOAD_VERIFICATION_FAILED`: SHA1 verification failed
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
const job = await node.downloadResult(1);
console.log(job.id, job.status);
```

Or choose the destination path yourself:

```ts
const job = await node.downloadResult(1, "./downloads/example.bin");
```

`downloadResult()` creates or updates a persisted background job and returns
immediately. Use `getDownloadJobs()` to inspect progress, `pauseDownload(id)`
to pause, `resumeDownload(id)` to requeue a paused or failed job, and
`removeDownload(id)` to forget a job and delete its incomplete file.

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
- `getDownloadJobs()`: persisted managed download jobs
- `getDownloads()`: completed download history for the current process

Example:

```ts
const status = node.getStatus();
const peers = node.getPeers();
const results = node.getResults();
const downloads = node.getDownloadJobs();
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
8. `downloadResult(...)` when needed, then inspect `getDownloadJobs()`
9. `save()` and `stop()` on shutdown

## Next Step

If you are mainly using the terminal, read [CLI.md](CLI.md) instead.

## Migrating to 2.0

The documented actions, package export paths, event shapes, and saved-data
formats remain supported. Undocumented mutable fields and low-level node
methods have been removed from the public facade. Use the public getters
and actions instead. `config()` and collection getters return snapshots;
change settings with `updateRuntimeConfig(patch)`, then `save()` to persist.
The constructor also takes its own copy of the supplied config document.
Existing config files, share indexes, jobs, and partial downloads need no
conversion. Bun 1.4.2 is required for public server-side TLS socket upgrades.

## Reading the Protocol Implementation

Start at [servent.ts](src/servent.ts). Its constructor connects the owners;
`start()` and `stop()` show their lifecycles. The CLI enters through
[bin/gnutonium.ts](bin/gnutonium.ts), while library consumers enter through
[src/protocol.ts](src/protocol.ts).

The source tree groups runtime code with the decisions and types it owns:

```text
src/
  servent.ts             Application composition and public actions
  protocol.ts            Public library exports
  cli*.ts                Commands, output, and interactive monitoring
  connections/           Dialing, ingress, handshakes, and peer sessions
    policy/              Handshake headers, capabilities, and admission rules
    topology/            Peer roles and connection-slot decisions
  routing/               Descriptor dispatch, forwarding, and return routes
    descriptors/         Duplicate, lifetime, response-route, and pong rules
    qrp/                 Query Routing Protocol tables, hashes, and patches
  search/                Query interpretation and numbered local results
  shares/                Catalog, matching, hashing, and share-index storage
  transfers/             HTTP, browse, direct downloads, and push callbacks
  downloads/             Job queue, retries, verification, and job storage
  discovery/             Remembered peers and local endpoint observations
    gwebcache/           Bootstrap and cache reporting
  config/                Configuration, saved documents, and peer-state format
  wire/                  Message encoders/decoders, headers, URNs, and GUIDs
  transport/             Socket ownership and shared socket operations
```

`types.ts`, `const.ts`, and `shared.ts` contain shared contracts, constants,
and generic helpers. Connection types live in `connections/types.ts`, wire
formats in `wire/types.ts`, and HTTP session state in
`transfers/session_types.ts`. Package export paths remain `gnutonium`,
`gnutonium/types`, `gnutonium/gwebcache`, and `gnutonium/query-routing`.

Follow one flow at a time:

1. **Local files to search results:** [shares/library.ts](src/shares/library.ts)
   scans files and maintains stable indexes and cached hashes. Catalog
   publication updates local QRP. [search/results.ts](src/search/results.ts)
   assigns result numbers and retains incoming hits.
2. **A query across the network:** begin with `sendQuery()` in
   [routing/origin.ts](src/routing/origin.ts), then follow packet dispatch and
   query/hit handlers in [routing/messages.ts](src/routing/messages.ts).
   [routing/queries.ts](src/routing/queries.ts) chooses peers using the pure
   routing rules; [routing/qrp_exchange.ts](src/routing/qrp_exchange.ts)
   exchanges their QRP tables. Original payloads remain available for forwarding.
3. **An incoming connection:** `handleProbe()` in
   [connections/handshake.ts](src/connections/handshake.ts) classifies Gnutella,
   HTTP, and GIV. After negotiation, [connections/session.ts](src/connections/session.ts)
   owns compression, listeners, and timers, while
   [connections/transport.ts](src/connections/transport.ts) frames descriptors
   and calls the router. [wire/codec.ts](src/wire/codec.ts) defines their bytes.
4. **A download:** `queueDownloadResult()` resolves the selected hit before
   calling [downloads/manager.ts](src/downloads/manager.ts). The queue owns
   scheduling, retries, pause, verification, and incomplete-file recovery.
   [transfers/download.ts](src/transfers/download.ts) owns direct and push
   transport. PUSH registers a callback, the router sends its descriptor,
   and GIV hands the socket to an HTTP download session.
5. **Discovery and saving:** [discovery/runtime.ts](src/discovery/runtime.ts)
   coordinates remembered peers and GWebCache work.
   [discovery/local_address.ts](src/discovery/local_address.ts) owns endpoint
   confidence. [config/runtime.ts](src/config/runtime.ts) provides detached
   settings; [config/document.ts](src/config/document.ts) loads and saves the
   existing document format. Share and download stores stay with those owners.

Unit tests follow the same domain directories under `tests/unit/`.
`tests/unit/servent/` covers behavior spanning several owners; reusable node
and socket fixtures live in `tests/helpers/`. Read
[tests/integration/protocol.test.ts](tests/integration/protocol.test.ts)
alongside the query and transfer flows to see small working networks.

Run `bun run verify` for deterministic checks and standalone builds. See
[tests/interop/README.md](tests/interop/README.md) for pinned GTK-Gnutella
checks and [acceptance.json](tests/interop/acceptance.json) for recorded
compatibility results.

## Import Organization

Run `bun run imports:organize` to organize imports across `src`, `bin`,
`tests`, and TypeScript scripts. It moves imports above declarations, then
uses TypeScript's language service to sort and merge imports and remove
unused bindings, followed by the repository's Prettier settings. Shebangs,
file headers, and directive prologues are preserved.

`bun run fix` includes this step. `bun run imports:check` checks without
writing; `bun run verify` includes that check to keep the layout consistent.
