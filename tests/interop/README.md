# GTK interoperability checks

These explicit Linux-only checks are separate from `bun run verify`.
A missing prerequisite is a failure, never a skip. The runner creates a
new user/network namespace with only loopback addresses and no external
route. GTK can attempt bootstrap, but cannot reach external services.
State, captures, and synthetic shared files live in a fresh `/tmp` folder.

Prerequisites: Bun 1.4.2 or newer, `unshare`, `ip`, Xvfb, and a GTK2/GnuTLS build of
GTK-Gnutella revision `3ce50bf0dd25e88e0d470eda61a0283a23ed49c6`.
Build with `scripts/build-interop-gtk.sh SOURCE_GIT_REPO OUTPUT_DIRECTORY`;
this archives the pinned revision without changing the supplied checkout.
The host needs GTK2 and GnuTLS development packages. The script records
compiler/dependency versions, build flags in `config.sh`, compile features,
and the resulting binary checksum. GNU17 is required with recent GCC.

Set `GTK_GNUTELLA_BIN` to the absolute executable path and
`GTK_GNUTELLA_SHA256` to its recorded checksum. Set `XVFB_BIN` if Xvfb is
not on PATH, then run `bun run test:interop`.

The default profile uses a GTK ultrapeer, a Gnutonium leaf, one Gnutonium
mesh neighbor, compression and TLS. GTK's desired ultrapeer count is set
to that single mesh neighbor so its dynamic query scheduler runs.
`INTEROP_GTK_ROLE=leaf` reverses the roles and connection direction.
`INTEROP_TLS=0` disables Gnutonium TLS; `INTEROP_COMPRESSION=0` disables
compression on both implementations. GTK's preference for compressed peers
is disabled so it can accept the uncompressed matrix profiles. Both
negotiated transport settings are asserted. Run all combinations with:

```sh
for role in leaf ultrapeer; do
  for tls in 0 1; do
    for compression in 0 1; do
      INTEROP_GTK_ROLE="$role" INTEROP_TLS="$tls" \
        INTEROP_COMPRESSION="$compression" bun run test:interop
    done
  done
done
```

The control client speaks GTK's local Unix-socket shell protocol, including
its required HELO preamble. GTK runs under Xvfb because this pinned revision
cannot create searches in topless mode. Shell replies, GTK diagnostics, wire
captures, scenario outcomes, and executable identity are saved in each
artifact folder. `GNUTONIUM_SOURCE_ROOT` may select another checkout with
the same internal test seams.

The suite checks connected-peer browse, managed direct download, range
resume, push download, text and SHA1-constrained search (with filename routing keywords), GTK-originated search, GTK's
own diagnostic confirming retained GUI results, and direct/push upload to
GTK. Transfers compare every file byte. Outgoing test sockets bind to the
synthetic client address so GTK can recognize private-network push sources.
The reverse-push case marks GTK reachable through its control shell because
the isolated network cannot supply normal external reachability probes. The
same status allows GTK to retain results advertising private addresses. GTK
publishes filename keywords in QRP, so the hash-search case supplies those
keywords along with the URN; pure-URN forwarding is covered by deterministic
routing tests.
Fragmentation, malformed frames, timeouts, cancellation, HTTP HEAD, connection
reuse, retry, and restart behavior remain covered by deterministic unit and
socket integration tests; the live matrix does not claim every error case.

## Compatibility evidence

All eight role/TLS/compression profiles passed ten scenarios each; see
[acceptance.json](acceptance.json). Compatibility fixes include:

- requiring Bun 1.4.2 and using the public server-side TLS constructor;
- recognizing direct TLS before HTTP/Gnutella ingress classification;
- pausing before replaying buffered ClientHello bytes, including when the
  final Gnutella header and TLS record arrive in one TCP chunk;
- accepting GTK's `Node` header as its listening endpoint for connected browse;
- publishing four-bit QRP patches (the pinned GTK one-bit receiver
  misindexes bytes in `qrt_apply_patch1`);
- awaiting GTK leaf QRP readiness before originating a query;
- using explicit magnet display names to avoid GTK's HTTP-URL shell
  allocator bug, with distinct synthetic contents in each direction.

The recorded [acceptance results](acceptance.json) identify the pinned build,
scenario outcomes, and hashes of full captures in their temporary artifact
folders. The `layoutVerification` section records the follow-up checks after
source reorganization. [Fixture provenance](../fixtures/gtk-1.3.1/provenance.json)
identifies the independently captured GTK bytes used by deterministic tests.
