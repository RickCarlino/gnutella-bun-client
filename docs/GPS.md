# Gnutella Pointer System

## Why

Gnutella is strong at distributing immutable content. A blog, profile, or update channel needs one more layer: a stable way to ask for the current pointer to the latest content.

The Gnutella Pointer System adds that layer with a small signed record. The record binds an identity and a topic to a magnet target. Updates are ordered with a sequence number. The newest valid record wins. Sequence numbers MAY be UTC unix timestamps.

This keeps content immutable and makes entry points stable.

---

## Core Idea

A pointer is identified by this tuple:

```text
(IDENTITY, TOPIC)
```

Each tuple has its own sequence stream:

```text
(IDENTITY, TOPIC, SEQUENCE) -> TARGET
```

Examples:

* `BLOG` for a blog front page
* `PROFILE` for a user profile
* `UPDATE` for a software update pointer

A publisher can have many schemes under one identity. Each topic advances independently.

---

## Query Format

Clients request a pointer with a normal Gnutella query string:

```text
gnutella:<topic>@<identity>
```

Examples:

```text
gnutella:blog@MFRGGZDFMZTWQ2LKNNWG23TPOI======
gnutella:profile@MFRGGZDFMZTWQ2LKNNWG23TPOI======
```

For wire compatibility and easy matching, implementations should use this normalized form internally:

* `gnutella:` in lowercase
* `<topic>` normalized to uppercase before matching
* `<identity>` encoded as Base32 uppercase without padding

Normalized example:

```text
gnutella:blog@JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ
```

A legacy client will flood this query like any other query. A compatible client can recognize the pattern and answer with a QueryHit for the matching pointer record.

---

## Identity Encoding

`IDENTITY` is the Ed25519 public key encoded as:

* RFC 4648 Base32
* uppercase
* no `=` padding

This keeps the identity line simple, portable, and safe to place in both query strings and text files.

---

## Record Format

Version 1 uses a five-line text record.

Line order is fixed:

```text
<IDENTITY>
<TOPIC>
<SEQUENCE>
<TARGET>
<SIGNATURE>
```

Example:

```text
JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ
BLOG
42
MAGNET:?XT=URN:BTIH:0123456789ABCDEF0123456789ABCDEF01234567&DN=INDEX.HTML
MZXW6YTBOI======MZXW6YTBOI======MZXW6YTBOI======MZXW6YTBOI======MZXW6YTBOI======MZXW6YTBOI======MZXW6YTB
```

The example above is shortened for readability. Real identities and signatures must contain the full encoded value.

---

## Field Definitions

### `IDENTITY`

The publisher's Ed25519 public key, encoded in Base32 uppercase without padding.

### `TOPIC`

An uppercase token that names the resource stream.

Recommended grammar:

```text
[A-Z][A-Z0-9-]{0,31}
```

Examples:

```text
BLOG
PROFILE
UPDATE
```

### `SEQUENCE`

A decimal unsigned integer that increases by one or more for each update of the same `(IDENTITY, TOPIC)` pair.

Recommended grammar:

```text
0|[1-9][0-9]*
```

Sequence numbers are tracked independently per `(IDENTITY, TOPIC)` pair.

### `TARGET`

The current magnet pointer.

Recommended form:

```text
MAGNET:?XT=URN:BTIH:<INFOHASH>
MAGNET:?XT=URN:SHA1:<SHA1>
MAGNET:?XT=URN:BITPRINT:<SHA1>.<TTH>
```

A display name may be included with `DN`.

For easy interoperability, write the magnet line in uppercase.

### `SIGNATURE`

The Ed25519 signature encoded as:

* RFC 4648 Base32
* uppercase
* no `=` padding

---

## Signing Rules

The signature covers the first four lines exactly.

Signature input bytes are:

```text
LINE1 "\n" LINE2 "\n" LINE3 "\n" LINE4
```

That means:

* use `\n` as the line separator
* do not add a trailing newline after line 4 when signing
* do not add leading or trailing spaces to any line
* preserve the exact bytes of the target line

The signature algorithm is Ed25519.

The `SIGNATURE` line stores the raw 64-byte Ed25519 signature in Base32 uppercase without padding.

---

## Record Parsing

A valid Version 1 pointer record:

1. has exactly five lines
2. parses each line according to the field rules above
3. verifies with Ed25519 using the public key from `IDENTITY`

A client should reject malformed records during parsing and keep working through other candidates.

---

## Publishing Flow

To publish or update a pointer:

1. Build or choose the new immutable content.
2. Create the magnet URI for that content.
3. Increment the sequence number for the `(IDENTITY, TOPIC)` pair.
4. Write the five-line pointer record.
5. Sign lines 1 through 4.
6. Share the pointer record as a normal file.

Each published pointer record is immutable. A new update produces a new pointer file with a higher sequence number.

---

## Resolution Flow

When resolving `gnutella:<topic>@<identity>`:

1. Normalize the query into:

   * `TOPIC` uppercase
   * `IDENTITY` Base32 uppercase without padding
2. Flood the query through the network.
3. Collect candidate pointer files from QueryHits.
4. Parse each candidate as a five-line pointer record.
5. Verify:

   * `IDENTITY` matches the query
   * `TOPIC` matches the query
   * signature verifies
6. Select the valid record with the highest `SEQUENCE`.
7. Resolve its `TARGET` magnet as usual.

This gives a stable naming layer on top of ordinary content-addressed distribution.

---

## Local Indexing

A compatible client should index the highest valid record it knows for each tuple:

```text
(IDENTITY, TOPIC) -> HIGHEST_SEQUENCE_RECORD
```

This makes query handling fast and keeps resolution simple.

A client may also keep older records for history, debugging, or conflict handling.

---

## QueryHit Behavior

When a client receives a query matching:

```text
gnutella:<topic>@<identity>
```

it should:

1. normalize the query
2. look up the highest valid local record for `(IDENTITY, TOPIC)`
3. return a QueryHit for that pointer file

A client may also return additional older records if it wants to support history-aware tools, though returning the newest valid record is usually enough.

---

## Conflict Handling

A healthy pointer stream has one highest valid sequence number for each `(IDENTITY, TOPIC)` pair.

If a client sees multiple valid records with the same `IDENTITY`, `TOPIC`, and `SEQUENCE` but different `TARGET` values, it should treat the stream as conflicted and surface that state clearly.

This keeps automatic resolution predictable and makes operational problems visible.

---

## Recommended Filename

The record body is authoritative. A predictable filename still helps people and simple local indexes.

Recommended filename format:

```text
PTR.<TOPIC>.<IDENTITY>.<SEQUENCE>.TXT
```

Example:

```text
PTR.BLOG.JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ.42.TXT
```

---

## Worked Example

### Query

```text
gnutella:blog@JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ
```

### Pointer Record

```text
JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSQ
BLOG
42
MAGNET:?XT=URN:BTIH:0123456789ABCDEF0123456789ABCDEF01234567&DN=INDEX.HTML
KRSXG5CTMVRXEZLSEBQW4ZBAON2HE2LOM4QGS3THEBWXU2LPNZRW63RAN5ZG6Y3JONQXG5DJN5XGO3TFOJQXI2LPNYQGK3TDMU
```

### Meaning

This says:

* the identity is the public key on line 1
* the topic is `BLOG`
* the newest known sequence is `42`
* the current blog entry point is the magnet on line 4
* the signature proves the record came from the holder of the corresponding private key

---

## Why This Fits Gnutella Well

This system uses the network as it already exists:

* discovery through ordinary query flooding
* transfer through ordinary QueryHits and downloads
* immutable content behind a magnet target
* a small signed text file as the mutable layer

The result is simple to implement, easy to inspect, and easy to debug.

---

## Summary

The Gnutella Pointer System gives Gnutella a practical naming layer.

It lets a client ask for:

```text
gnutella:<topic>@<identity>
```

and resolve that request to the newest valid magnet target published by that identity for that topic.

That is enough to build stable blogs, profiles, release channels, and similar resources on top of ordinary Gnutella behavior.

## Glossary

**Identity**
An Ed25519 public key encoded in Base32 uppercase without padding. It identifies the publisher of a pointer stream.

**Topic**
An uppercase label that identifies a resource stream under one identity, such as `BLOG`, `PROFILE`, or `UPDATE`.

**Pointer**
A signed record that binds an `(IDENTITY, TOPIC)` pair to a current magnet target.

**Pointer Stream**
The ordered set of pointer records for one `(IDENTITY, TOPIC)` pair.

**Sequence**
A decimal unsigned integer that orders updates within one pointer stream. Higher values are newer.

**Target**
The magnet URI referenced by a pointer record. It identifies the current immutable content for that pointer stream.

**Signature**
An Ed25519 signature over the first four lines of a pointer record. It proves that the record was created by the holder of the private key corresponding to `IDENTITY`.

**Pointer Record**
The five-line text file used by the Gnutella Pointer System:

```text
<IDENTITY>
<TOPIC>
<SEQUENCE>
<TARGET>
<SIGNATURE>
```

**Query String**
The search string used to request a pointer record from the network:

```text
gnutella:<topic>@<identity>
```

**Resolution**
The process of querying the network, collecting candidate pointer records, verifying them, and selecting the valid record with the highest sequence number.

**Normalization**
The process of converting values into their required canonical form before matching or signing. In this system, that mainly means uppercase text, `\n` line separators, and Base32 uppercase without padding for identities and signatures.

**Canonical Form**
The exact byte representation that all compatible clients must use when generating or verifying signatures.

**Magnet URI**
A URI that points to immutable content by hash, such as a BitTorrent infohash or SHA1-based Gnutella resource identifier.

**QueryHit**
A normal Gnutella search response that points to a downloadable pointer record file.

**Candidate Record**
Any downloaded file that might be a valid pointer record for a given query.

**Highest Valid Record**
The valid pointer record with the greatest `SEQUENCE` value for a given `(IDENTITY, TOPIC)` pair.

**Conflict**
A condition where multiple valid pointer records exist with the same `IDENTITY`, `TOPIC`, and `SEQUENCE`, but different contents.

**Publisher**
The user or client that creates and signs pointer records.

**Resolver**
A client that searches for, verifies, and selects pointer records.

**Local Index**
A client-side lookup table that stores the highest valid pointer record known for each `(IDENTITY, TOPIC)` pair.

**Immutable Content**
The actual content referenced by `TARGET`. Once published, it is identified by hash and does not change.

**Mutable Pointer Layer**
The signed record layer that allows a stable identity and topic to resolve to updated immutable content over time.
