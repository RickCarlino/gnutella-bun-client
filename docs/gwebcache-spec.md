# Gnutella GWebCache (GWC) Protocol – Gnutella 0.6 & Gnutella2 Specification

**Overview:**
A Gnutella Web Cache (GWC) is a simple HTTP service that bootstraps peers into the Gnutella networks. Both modern Gnutella (v0.6) and Gnutella2 (G2) clients use GWCs to fetch initial host addresses when connecting. The GWC maintains lists of active node IPs (often ultrapeers or hubs) and may also list other cache URLs, helping clients discover peers even if their local cache is empty. A fully compliant GWebCache supports HTTP GET-based queries for retrieving hosts and caches, and handles client update requests (via query parameters or POST) to add new hosts or caches. Below we detail the supported operations, parameters, and formats for Gnutella (spec “1”) and Gnutella2 (spec “2”) caches, as well as guidance on abuse prevention and cache maintenance.

## Supported Operations and Endpoints

**1. Retrieving Host Lists:** Clients query the cache to obtain a list of active host nodes (IP\:port pairs) to connect to the network. In the original spec (Gnutella 0.6), the client performs an HTTP GET with `hostfile=1` to request hosts. In the extended spec (used by Gnutella2 and multi-network caches), a unified `get=1` parameter is used to request **both** hosts and cache URLs in one call. (Legacy Gnutella2 clients may also use `hostfile=1` on modern caches – many caches accept old parameters for backward compatibility.)

**2. Retrieving Cache (URL) Lists:** Clients may also request a list of alternate GWebCache URLs to diversify their bootstrap sources. In Gnutella 0.6 spec, this is done with `urlfile=1` in the query. In spec 2, this is again encompassed by `get=1` (which returns both hosts and caches) or can be requested alone by legacy `urlfile=1` for backward compatibility.

**3. Combined Host+Cache Query:** Spec 2 caches inherently return both hosts and cache URLs when using `get=1`. In the older spec, combining both was non-standard but some caches implemented a `bfile=1` parameter to return hosts and caches together. Modern caches typically use `get` (with a network specifier, see below) for a combined response.

**4. Submitting/Updating a Host:** Clients (or caches on behalf of a client) inform the GWC of a new host (usually their own IP\:port if they are an ultrapeer or hub) so that it can be cached for others. In spec 1, the presence of an `ip` parameter in the request triggers an update; the client may call an URL like `...?ip=12.34.56.78:6346` to submit itself. Spec 2 formalizes this with an `update` action: the request can include `update=1` (or simply the `ip` parameter, as caches infer an update if an IP or URL is provided). The `ip` value should be the node’s external IP and port. On success, the cache responds with an acknowledgment (format detailed below).

**5. Submitting/Updating a Cache URL:** Similarly, caches share knowledge of other caches. A client or cache can submit a new cache’s URL via the `url` parameter. In spec 1, adding `url=http://...` in the query tells the GWC to consider that address as a new cache. In spec 2, this is part of the `update` mechanism: e.g. `...?update=1&url=http://newcache.example.com/gcache.php`. (Older implementations used `ip1` and `url1` for updates – now deprecated.)

**6. Ping/Cache Identification:** Including `ping=1` in any request asks the cache to include an identification “pong” in its response. This is not a separate HTTP endpoint, but a flag in the query that triggers an info line in the output. The ping operation is identical in purpose across spec 1 and 2, but the output format differs (see **Response Formats**). It’s used for cache-to-cache pings and client verification of cache status.

**HTTP Method:** By default, these operations are invoked via HTTP GET requests with query parameters. The exchange uses standard HTTP/1.0 or 1.1 semantics. (Some cache implementations may accept HTTP POST for updates to avoid long URLs, but this is not universally required – GET is the norm and what clients typically use.)

**Example:** A Gnutella2 client might GET:

```
http://cache.example.org/gcache.php?get=1&net=gnutella2&client=RAZA&version=2.3.1.3&ping=1
```

This single request asks for hosts and caches for the G2 network, identifies the client as Shareaza (RAZA) v2.3.1.3, and requests a pong line.

## Request Parameters and Usage

### Common Parameters (All Specs)

- **`client`** – A four-letter client identifier (e.g. `RAZA` for Shareaza, `LIME` for LimeWire, etc.). This helps the cache log which client made the request.
- **`version`** – The client software version (arbitrary string or number). Used for statistics or to customize responses if needed.
- **`ping`** – If present (usually `ping=1`), the cache will include a “pong” header line identifying itself in the response. (No effect on the data returned, just an info line.)
- **`ip` / `url`** – Indicates the client is **submitting** a host or cache. These parameters carry the value to add. The IP should be in `x.x.x.x:port` format and the URL should be a full http\:// URL to the other cache. Including either or both signals an update operation. (Spec 2 uses them under an `update` context – see below.)

### Specification 1 (Gnutella 0.6) Parameters

Spec 1 covers classic Gnutella caches that only serve the Gnutella network. **No explicit network parameter** is used – it’s implicitly Gnutella (v0.6). Key query params include:

- **`hostfile=1`** – Request a list of host IP\:ports. The cache will return active Gnutella node addresses.
- **`urlfile=1`** – Request a list of known GWebCache URLs. The response will list other cache URLs.
- **`bfile=1`** – (Optional/Non-standard) Request both hosts and cache URLs in one response. Not part of the original spec, but some caches (e.g. Beacon) support `bfile` for a combined output. Absent in many older caches.
- **`ip` / `url`** – As described, submitting a host or cache. In spec 1, no separate `update` flag is needed; the presence of `ip` and/or `url` triggers the update. The cache will process the new entry and reply with a status line (OK or WARNING) instead of a host list (see Response Formats).
- _(Deprecated:_ \*_`ip1`, `url1` – older caches used these for updates; modern caches still recognize them but they are equivalent to `ip`/`url` now.)_

**Note:** Spec 1 caches don’t support multi-network. If a Gnutella2 client accidentally queries a spec1 cache, it will simply get Gnutella addresses. Some caches may return an error if they detect an unsupported network, for example replying with a 503 error “Required network not accepted” instead of data.

### Specification 2 (Gnutella2 & Multi-network) Parameters

Spec 2 extends the protocol to support multiple networks (e.g. Gnutella _and_ G2) and more structured responses. Key additions and differences:

- **`net`** – **Network selector (required for multi-network caches).** Specifies which network’s data is requested. Values are typically `gnutella` or `gnutella2` (all lowercase). A cache that serves both will use this to filter its host list. If `net` is missing, caches may default to spec1 behavior (assuming Gnutella). It’s recommended that clients always send `net` to avoid ambiguity. (A cache can advertise its supported networks in the pong, e.g. “gnutella-gnutella2” as described below.)
- **`get=1`** – Unified retrieval request. In spec 2, clients use `get` to request both hosts and caches in one go. The response will contain both `H|...` and `U|...` entries (see next section). This simplifies bootstrap for clients. (Spec2 caches typically also honor `hostfile` or `urlfile` if provided, but using `get` with `net` is the preferred approach.)
- **`update=1`** – An explicit flag (often optional) indicating that the client is sending an update (new host and/or cache). In practice, a spec2 cache may infer an update from the presence of `ip`/`url` params, but including `update=1` is good form. This flag doesn’t carry a value itself; it just tells the server to return an `I|update|...` status line in the response acknowledging the submission.

  - When updating, the client can also combine it with a get request if desired (e.g. ask for the current list while submitting itself). GWC spec allows multiple operations in one query string, which caches should handle properly.

- **`ip` and `url`** – Same usage as spec1: values to add. When used with `update`, these inform the cache to add the peer and/or the new cache to its database.
- **`cluster`** – (Optional) A string tag to categorize the host (some experimental use). If a client provides `cluster=XYZ` along with an IP update, spec2 caches will include that cluster tag in the host entry output (as an extra field). This is rarely used; it’s primarily for specialized clustering of hosts.
- **Extended query options:** Spec 2.1 introduced additional optional params for richer host info:

  - **`getleaves=1`** – Request the number of leaves an ultrapeer (G2 hub) has. If the cache has that info, host lines will include leaf counts.
  - **`getclusters=1`** – Request cluster tags in output (if supported).
  - **`getvendors=1`** – Request the host’s vendor code/version (cache may have learned this from prior pings).
  - **`getuptime=1`** – Request the host’s reported uptime (in seconds) if known.
    These are optional debugging or network research features – not required for basic interoperability, but a “fully compliant” cache _could_ support them. Absent these flags, the cache can omit those extra fields.

- **Backward Compatibility:** Spec2 caches often still support `hostfile=1` and `urlfile=1` parameters and will return data in _spec2 format_ or _spec1 format_ depending on context. Many caches simply treat any request without `net` as spec1 (return plain lines). Others (Beacon cache) accept old params but still output the new format. Additionally, a `spec=` parameter exists (primarily in Beacon implementations) to force a certain spec mode (e.g. `spec=1` or `spec=2`).

## Response Formats and Examples

Output format differs significantly between Spec1 and Spec2, though the core content (lists of hosts and caches) is the same information.

### Spec 1 (Gnutella) Response Format

Responses are plaintext with one item per line (except the “OK” line). Key elements:

- **Pong Line:** If `ping=1` was included, the first line of the response is a **pong** identifier. In spec1 it appears as:
  `PONG CacheName Version`
  e.g. `PONG Beacon Cache 0.1.5D Beta`.
  (No network is indicated here, since spec1 caches implicitly serve Gnutella only.)

- **Host Entries:** Each host is given as `IP:Port` (no prefix, just the address). One host per line. For example:
  `66.132.55.12:6346`
  `99.248.214.157:27529`
  etc. There is no explicit count or separator beyond newlines. The example host output above shows a series of such entries (each representing an ultrapeer).

- **Cache Entries:** Each cache URL is given in full (including `http://` and port if non-80). In responses, caches might be separated by whitespace or newlines. Typically, each URL is on a separate line as well. For example:
  `http://somecache.example.com/gcache.php`
  `http://othercache.net:8080/cache.php`.
  (In some spec1 outputs, caches were listed space-separated after the PONG line; however, newline-separated is more readable and many implementations use one per line.)

- **Combined Output:** If a spec1 cache supports a combined response (via `bfile`), it will essentially output the PONG line (if requested), then host lines, then cache URL lines. The example “bfile” output in Beacon’s case shows hosts followed by URLs all in one response. This was not standardized, so not all caches handle `bfile`.

- **Update Acknowledgments:** When a client submits data (`ip`/`url`) without also asking for `hostfile`/`urlfile`, the cache may return a short status instead of a list. Spec1 defines:

  - **OK** – if the update went fine.
  - **OKWARNING: <msg>** – if the update succeeded but there’s a minor issue (e.g. “OKWARNING: Already present” or similar).
  - **WARNING: <msg>** – if the update failed or is not accepted (no “OK” prefix in this severe case). For example, a cache might reply `WARNING: Invalid IP` or `WARNING: You came back too early` for an improper submission.
    These lines appear alone (no host or URL list follows, since the request was just an update). The client can parse these to know if their info was recorded.

**Spec1 Example:**
A Gnutella 0.6 client might request: `?hostfile=1&ping=1&client=LIME&version=4.12`. The cache could respond:

```
PONG ExampleCache 1.0
24.150.143.77:6346
58.85.231.135:6346
... (several more hosts) ...
```

If the same client also requested `urlfile=1`, the response would include lines of http\:// URLs for other caches. If the client instead sent an update (`?ip=24.150.143.77:6346`), the cache might reply with just:

```
OK
```

(to confirm the update) or a warning message if there was a problem.

### Spec 2 (Gnutella2/Multi-network) Response Format

Spec2 responses are more structured, with each line prefixed by a code indicating its type. This makes parsing unambiguous. The main line types are:

- **Info (“I”) Lines:** Start with `I|` and convey meta-information: a pong, update status, warnings, or other info.

  - **Pong:** Format: `I|pong|CacheName Version|networks`. The networks field indicates which networks this cache serves (e.g. `gnutella`, `gnutella2`, or `gnutella-gnutella2` for both). Example:
    `I|pong|Beacon Cache 0.1.5D Beta|gnutella-gnutella2`.
    This corresponds to the spec1 “PONG ...” but with network info attached for client-side validation. If a cache only serves one network, it will list just that one.
  - **Update Status:** If an update was in the request, the cache returns an info line acknowledging it:

    - `I|update|OK` – update succeeded.
    - `I|update|OK|WARNING` – succeeded with a minor warning.
    - `I|update|WARNING|<message>` – failed or major issue.
      (Some caches might use `I|update|WARNING` without “OK” prefix for errors, and possibly include a message after a bar or as a separate warning line. The Shareaza spec shows both forms.) In practice, an update response might be `I|update|OK` or `I|update|WARNING|Duplicate host` etc.

  - **Plain Warning:** General warnings not tied to an update are given as `I|WARNING|<text>`. For example, if a client violates a rule, the cache might include `I|WARNING|You came back too early` in the output. This indicates the request was handled but something was improper (often rate-limit related).
  - **Other Info Lines:** Spec2 also allows other info queries like `info` or `support` in the request, which would produce lines like `I|open-source|1` or `I|support|gnutella2` (these are mainly for debugging/statistics). In normal bootstrap usage, these are not present unless specifically requested.

- **Host (“H”) Lines:** Each active host is listed on its own line starting with `H|`. The base format is:
  `H|IP:port|age`.
  The _age_ is the number of seconds the host entry has been in the cache (essentially, how “old” the record is). For example:
  `H|65.9.200.243:4968|248261` means that host was added \~248,261 seconds (\~2.87 days) ago.

  If **clustering** is used, a fourth field appears with the cluster tag (e.g. `H|1.2.3.4:6346|45|someCluster`). Further, if extended fields are enabled (via `getleaves`, `getvendors`, `getuptime`), additional fields may appear:

  - 5th field: leaf count (if `getleaves` requested).
  - 6th field: vendor code and version of that host (if `getvendors` requested – though Shareaza wiki indicates vendor in 6th, uptime in 7th, it appears there’s a slight indexing shift in that text).
  - 7th field: reported uptime in seconds (if `getuptime` requested).
    These are only present if those options are used; otherwise host lines have 2 or 3 fields (IP\:port, age, and maybe cluster).

- **Cache URL (“U”) Lines:** Each known cache is listed with a `U|` prefix. Format:
  `U|http://cache.url[:port]/path|age`.
  The URL is given in full (with `http://`), and if it uses a non-standard port it will include it. The age is seconds in cache, similar to hosts. For example:
  `U|http://gwc2.wodi.org/skulls.php|248384` indicates that cache has been known for \~248,384 seconds. Usually only the domain or short form is shown after the pipe in documentation, but the actual output includes the full URL up to the `|` separator.

- All lines are separated by newline `\n` (or `\r\n` per HTTP standards). The ordering in a `get` response typically is: one `I|pong` line (if ping requested), followed by multiple `H|...` lines, followed by multiple `U|...` lines. If an update was included, an `I|update|...` line will also appear, usually at the top after the pong (before listing entries) or at the bottom – implementations vary, but including it at top as a header is common.

**Spec2 Example:**
The earlier example URL `...?get=1&net=gnutella2&client=RAZA&version=2.3.1.3&ping=1` might yield:

```
I|pong|ExampleCache 2.0|gnutella-gnutella2
H|192.0.2.100:6346|3600
H|198.51.100.45:3000|120
H|203.0.113.12:6346|50
U|http://cache1.example.net/gcache.php|7200
U|http://cache2.example.org/cache.php|300
```

_(Here the cache serves both networks, hence both “gnutella-gnutella2” in the pong.)_ The host lines show IPs with ages (in seconds). The cache lines show other caches and how long they’ve been known. If the client also submitted its own info (say it included `ip=192.0.2.50:6346`), the response might prepend an update acknowledgement like:

```
I|update|OK
```

indicating the cache added the host successfully.

If a requested network is not supported by the cache, the cache may respond with an error. Some caches use an HTTP error code 503 with a plain message. For example, a Gnutella-only cache receiving `net=gnutella2` could reply with HTTP 503 and the text “Required network not accepted” to signal it cannot serve that network.

## Abuse Prevention and Validation Mechanisms

GWebCaches are open services and can be subject to abuse (excessive querying, spam entries) – most implementations include basic countermeasures:

- **Query Rate Limiting:** Caches typically limit how often a given client/IP can query. It’s recommended that clients query a GWC at most **once per session** (i.e., only if truly needed on startup). Excessive requests may be dropped or answered with a warning. For example, caches may track the time of last query per IP and if a repeat query comes “too early,” respond with a warning like `I|WARNING|You came back too early`. This alerts the client it’s querying too frequently. As a rule of thumb, one GWC query per fresh startup (or per hour) is a reasonable limit. Caches often implement a minimum interval (e.g. 1 minute or more) between queries from the same IP.

- **IP Banning/Filtering:** Many GWCs maintain a blacklist of abusive IPs or networks. If an IP spams requests or submits bogus data, the cache may ban it (ignoring requests or returning errors). Caches might also reject _private/reserved IPs_ in submissions – e.g. if someone tries to add `192.168.x.x` or `127.0.0.1`, the cache should not list those. Submissions of obviously invalid hosts are typically dropped silently or with a warning.

- **Host Validation:** To keep the host list fresh, some caches validate submitted hosts. For instance, a cache could attempt a quick TCP handshake or Ping/Pong exchange with a newly submitted node to ensure it’s alive before caching it. This isn’t strictly required (and many caches do not actively probe every submission due to load), but it’s a recommended practice for quality. One mechanism is to only accept hosts that are likely ultrapeers: e.g. a cache might require that a Gnutella host claims to have a certain number of leaf connections before accepting it. Indeed, the Bazooka GWC script had an option `$BAZ_LEAF_COUNT` to only add a host if it has at least 50 leaves (an indicator it’s an ultrapeer) – though in practice this was not very effective and often disabled.

- **Cache URL Validation:** Caches cross-verify new cache submissions to prevent pollution with bad URLs. When one cache receives a new cache URL via `url` param, it may send a “ping” (a GET with `ping=1`) to that URL to ensure it’s a working GWebCache. Many caches enable such validation by default. For example, Bazooka’s `$BAZ_URL_ON` setting controls whether the cache will **connect to each submitted cache URL to check it**; if disabled, it rejects all cache updates. With it enabled, the cache tries the URL – if it responds like a valid GWC, then it’s added to the list, otherwise it’s ignored. Similarly, Bazooka’s `$BAZ_KS_ON` could double-check by connecting (though it might duplicate efforts).

- **Duplicate & Staleness Checks:** If a host or cache is already in the database, the cache might not add it again or will reset its age. Caches often store a timestamp for each entry. For example, if a cache submission arrives that already exists, the cache can update its “last seen” time instead of duplicating. Bazooka caches would re-validate caches older than 14 days on re-submission and drop them if unresponsive. This means caches have an _eviction policy_ for old entries: if an entry hasn’t been refreshed in a certain number of days, it’s purged or rechecked. A common approach is to expire hosts that haven’t been seen in e.g. 1–3 days and expire cache URLs after a couple of weeks if not reconfirmed.

- **Throttling and Response Shaping:** Some caches deliberately return a limited number of hosts per query (even if they know more) to prevent clients from grabbing the entire list constantly. For instance, a cache might store hundreds of hosts but only return, say, 20 each time. This both limits bandwidth and encourages distribution of load (different clients might get different subsets). The Gnutella 0.6 spec recommended sending on the order of 10–20 hosts to a client in a response (similar to how X-Try headers are populated with \~10–20 addresses). Caches follow this by configuring a max number of H and U lines to output (commonly 20 hosts, and perhaps a dozen caches as seen in examples). If the cache has more entries, it may choose the freshest or random selection.

- **“Vendor” and Pattern Bans:** Some caches analyze the `client` (vendor code) in requests or the User-Agent (if any is provided in the HTTP header) to detect known bad actors. For example, a cache maintainer might ban a certain client that was behaving maliciously. The Beacon cache code allowed banning by the “pong” signature or vendor of other caches. While this is more about inter-cache pings, it shows caches can apply policy based on who is querying.

In summary, a robust GWebCache should implement **basic rate limiting**, avoid listing obviously bad data, and periodically prune its lists to ensure only active hosts/caches remain. The protocol itself provides the framework (update messages, warnings) to support these policies.

## Cache Size, Storage & Eviction Recommendations

There is no hard-coded limit in the protocol for how many entries a GWC should hold, but practical guidelines exist from the community:

- **Host List Size:** A GWebCache is typically not meant to be an exhaustive index of all peers – just a rotating sample of _recently seen active peers_. Many caches keep on the order of a few hundred IPs. This ensures responses are fresh and manageable. When the list grows large, caches should evict old or inactive hosts. For instance, one could cap at **500 hosts** (as an example) and use an eviction policy like _oldest first removal_ when adding new ones beyond the cap. The “age” field in host entries (in seconds) gives an indication of staleness; a cache might drop hosts older than e.g. 48–72 hours even if the list isn’t full, under the assumption they might have gone offline. In the example outputs above, the oldest host ages were around 248000 seconds (\~2.87 days) – that suggests a turnover of a few days is expected. Hosts that regularly refresh (via being re-submitted or observed by cache pings) will have their age reset; those that don’t will age out and eventually be evicted.

- **Cache List Size:** The cache-of-caches (list of other GWC URLs) is usually smaller. A cache might know of, say, a few dozen other caches at most. It’s often counter-productive to list too many, since clients only need a few alternate caches to try. We recommend maintaining perhaps **10–20 cache URLs** in the list of trusted caches. When new caches are submitted, verify them (as above) and then include them, possibly evicting an old one if the list grows too large or if an existing cache hasn’t been heard from in a long time. As a policy, if a cache URL fails validation (no response or invalid format) when you attempt to ping it, consider dropping it. Bazooka’s default was to re-check caches after 14 days of no updates. A safe strategy: remove any cache that has not responded to your last few pings or which hasn’t been updated in two weeks (or some fixed threshold).

- **Data persistence:** Store the host and cache lists in a simple database or flat file. Many PHP-based GWCs use flat files (as indicated by “flat files” in the implementation list). Ensure that on service restart, the cache doesn’t start empty – i.e., save the lists to disk regularly. Some implementations also use SQL for persistence, which is fine as well.

- **Eviction Policy:** Use either an age-based expiry (e.g. drop entries older than X) or a fixed-size ring buffer. The goal is to keep the cache filled with currently active nodes. Also consider evicting entries that consistently fail to appear in client queries or that were added by a single client and never re-confirmed – those might have been one-off or malicious. Pair eviction with validation: e.g., if you haven’t heard an entry in a while, try pinging it; if it doesn’t respond, remove it.

- **Rate Limiting Policy:** We touched on this above, but to reiterate in terms of implementation: you can keep a timestamp of last query per IP (in memory or a small cache) and simply refuse or warn if a repeat comes too soon. “Too soon” could be 30 seconds for the same IP, for example. Also, a total cap like _no more than N queries from the same IP per hour_ can be set (the GWC’s `statfile` can help monitor this – it provides total requests and requests/hour stats). If you notice in stats that one IP is hitting far more than others, it might warrant a temporary ban.

Implementing these policies will make your GWebCache robust and prevent it from being overwhelmed or polluted. Remember, a GWebCache’s role is **primarily bootstrap** – once peers connect, they share addresses among themselves (e.g. via X-Try headers and Gnutella pings) and reliance on the GWC is minimal. Thus, the cache just needs to provide a steady trickle of fresh hosts and propagate knowledge of caches, while guarding against misuse.

## Conclusion and References

By following the above pseudo-specification, you can build a GWebCache that interoperates with existing Gnutella 0.6 clients and Gnutella2 clients, handling all required query types and updates. We covered the essential GET parameters and response formats for both the legacy Gnutella cache protocol and the extended multi-network version (which G2 uses). We also highlighted best practices in terms of abuse prevention (throttling, validation) and cache management (size limits, eviction). These guidelines are distilled from official Gnutella specs and community documentation, including the Shareaza wiki and historical Gnucleus specifications. A properly implemented cache will significantly assist peers in joining the network while minimizing maintenance overhead. Good luck with your implementation!

**Sources:** Gnutella protocol specs and developer notes, Shareaza Wiki (GWC technical details), and community best practices. These ensure the cache will be fully compliant and compatible with current Gnutella and G2 clients. Each aspect from request handling to output format is grounded in the established specifications to guarantee interoperability.
