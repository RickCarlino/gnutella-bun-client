# Implementing Gnutella Query Routing Protocol v2 (Leaf Mode) – Pseudospec

## Overview of QRP and Dynamic Querying

Modern Gnutella (v0.6) introduced **Ultrapeers** and key search enhancements like the **Query Routing Protocol (QRP)** and **Dynamic Querying (DQ)** to improve scalability. QRP allows each peer to send its Ultrapeers a **Query Routing Table (QRT)** – essentially a Bloom-filter summary of the keywords it shares. This lets Ultrapeers forward queries **only** to those leaves likely to have matches, rather than flooding every leaf. DQ, on the other hand, is a technique where search queries that return too few results are iteratively expanded (re-flooded with higher TTL) to reach more peers. Together, QRP and DQ dramatically reduce redundant traffic while preserving search coverage.

**Goal:** Implement minimal QRP **v2** support in a leaf-node client so it can connect to Ultrapeers without a “503 No QRP” rejection. This means advertising QRP capability in the handshake and sending a basic QRP table (even a trivial or empty one) to each Ultrapeer. We will focus only on the essentials – correct headers, basic QRP table format (Bloom filter bits), and required `RouteTableUpdate` messages – without delving into advanced optimizations or full query routing logic.

## Handshake Requirements (Avoiding 503 Rejection)

Gnutella’s 0.6 handshake is an HTTP-like exchange where peers advertise capabilities. To satisfy Ultrapeer expectations, a leaf **MUST** include the QRP support header in its initial handshake request. In practice, the leaf’s handshake should contain:

* **`X-Ultrapeer: False`** – Indicates this node is a leaf (seeking an Ultrapeer).
* **`X-Query-Routing: 0.2`** – Signals support for QRP, version 2 (v2). The value “0.2” denotes QRPv2 (older implementations used “0.1” for QRPv1).

Example (leaf → ultrapeer):

```
GNUTELLA CONNECT/0.6  
User-Agent: YourClient/1.0  
X-Ultrapeer: False  
X-Query-Routing: 0.2  
[...other headers...]  
```

If this header is missing, modern Ultrapeers will assume the leaf cannot do QRP and likely respond with an *error*. In Gnutella, a 503 status is used to refuse connections – e.g. an Ultrapeer might send `GNUTELLA/0.6 503 Service Unavailable` (reason: “No QRP” or similar) and disconnect. Including `X-Query-Routing: 0.2` prevents that failure. On acceptance, the Ultrapeer’s reply (`200 OK`) may also include its own QRP indicators (e.g. `X-Ultrapeer-Query-Routing: 0.2` if it’s an Ultrapeer that can exchange QRP with other Ultrapeers).

> **Note:** The QRP header is crucial. It *advertises* that the leaf will provide a QRP table shortly. If the handshake succeeds, the leaf should proceed to send its QRP table to the Ultrapeer without waiting for a prompt.

## QRP Table Structure (Bloom Filter Basics)

**What is a QRP table?** It’s a fixed-size array of slots (a bit vector or small-integer array) that encodes which keywords the peer has. In QRPv1 this table was just bits (1 = “I have at least one file with this keyword”, 0 = “no file with that keyword”). QRPv2 generalizes this to store small *numbers* in each slot, where the number represents the “minimum hop-distance” to a file with that keyword. In practice:

* For a **leaf node’s own table**, any keyword present is at distance 0 (the file is on the node itself). We can treat this similarly to a simple bitset for minimal implementation (present vs. not present). Ultrapeers that merge tables from multiple leaves may use distance values >0, but as a leaf we can ignore multi-hop distances except to set “no content” as an *infinite* distance.
* The default table size is typically **65,536 slots** (64 Ki). This is a power of two (making mod–hashing easy). Each slot corresponds to a possible hashed keyword value. Some implementations allow larger tables (Ultrapeers might combine into 128 Ki slots or more), but as a leaf 64Ki is sufficient and widely used.

**Hashing keywords to the table:** The leaf must hash each **keyword** of each shared file into one or more slot indices and mark those slots. The steps:

1. **Extract keywords** from file names (and optionally metadata): usually split on whitespace and punctuation.
2. **Normalize** each keyword: for consistency, convert to lowercase and remove accents/diacritics (e.g. `"Déjà"` → `"deja"`). Non-ASCII characters are typically flattened to ASCII. You may also drop very short common words (stop-words) if desired, but for minimal implementation it’s okay to include all words of length ≥ 2.
3. **Hash** the keyword to an index in \[0, table\_size-1]. QRP doesn’t mandate a specific hash in the handshake, but all modern clients use the same well-known function for compatibility. (For example, the original spec uses a custom string hash that mixes bits thoroughly and then takes the top N bits for the index. For pseudocode, you can substitute a reliable hash like FNV-1a or a truncated SHA-1.)
4. **Mark the slot**: In a bit-array table, set that slot’s bit = 1 to indicate at least one keyword hit. In a v2 “distance” table (4-bit per slot, etc.), you would set the value to 0 (zero hops) for that slot if you have the keyword (and leave it at ∞ if not).

Because this is effectively a **Bloom filter**, multiple different keywords may map to the same slot (collision). That’s expected – QRP tolerates false-positives (a slot might be 1 even if the specific query word wasn’t originally there, due to hash collision), but **never false-negatives**. In other words, if a peer has a keyword, its table slot will definitely be marked; if it doesn’t have a keyword, its table *usually* stays unmarked (unless another keyword collided). Ultrapeers thus forward a query to a leaf only if *all* query words hashes appear in that leaf’s QRT. If any word’s slot is 0/∞, the Ultrapeer knows that leaf can’t have the file and spares it from the query traffic. This “shields” the leaf from irrelevant queries.

*Minimal approach:* Implement a **single-hash, 1-bit-per-slot** QRP table. This aligns with QRPv1 behavior but is still valid under QRPv2 protocol (just use `Entry-Bits = 1` as we’ll see). This is much simpler and will be accepted by Ultrapeers – it ensures you won’t get flooded with queries, even if it’s not as compact or collision-resistant as a multi-hash Bloom filter.

## QRP Message Formats – `RouteTableUpdate` (Reset & Patch)

After the handshake, the leaf must send its QRP table to the Ultrapeer. The Gnutella descriptor type used is **RouteTableUpdate** (message type ID `0x30`). This is a **special control message** that carries pieces of the routing table. There are two variants of RouteTableUpdate to implement:

* **Reset Variant (`Variant = 0x0`):** Announces the start (or full replacement) of a QRP table. Upon receiving a Reset, the Ultrapeer will **clear any existing QRT** for that leaf and initialize a new empty table of the given size. The reset message typically contains the table’s size and some metadata. In QRP v2, the reset tells the receiver how many slots to allocate and what format to expect (e.g. entry bit-size). It also implicitly sets all slots to “no data” (infinite distance) until patches arrive. *Minimal detail:* We need to include the table length so the Ultrapeer knows how many slots we will fill. For example, for 65,536 slots, length = 65536. (There isn’t an explicit “infinity” marker needed for 1-bit tables, since 0 implies no content; for multi-bit tables, infinity is usually the max value, e.g. 0xF if 4-bit.)

* **Patch Variant (`Variant = 0x1`):** Contains actual table data to be applied (“patched”) into the current QRT. The table can be sent in one chunk or split into multiple patch messages. Each Patch message carries: a sequence number, total sequences, compression flag, entry size, and a block of data bytes. The Ultrapeer will insert these data into the table (either appending to a growing bitset or updating a range of slots). In practice, most implementations either send **one uncompressed patch** for the whole table or use simple compression like run-length encoding to shrink long runs of zeros.

For **minimal implementation**, it’s acceptable to send the entire table in one Patch message (if size permits) and use **no compression** (compression type = 0). A full 64Ki-bit table is 8192 bytes, which is under the recommended 4 KiB–**8 KiB** message size limit (Gnutella guidelines say avoid messages over \~4KB for efficiency, but 8KB is still generally fine). If needed, you could break it into two \~4KB patches, but many Ultrapeers will accept one 8KB patch.

### Message Field Layout

Both Reset and Patch use the same base format in the payload:

| Offset | Field           | Description                                                                                                                                                                                   |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | **Variant**     | 1 byte: `0x0` = Reset, `0x1` = Patch.                                                                                                                                                         |
| 1      | **Seq-No**      | 1 byte: Sequence number of this Patch (for Reset, often 0).                                                                                                                                   |
| 2      | **Seq-Count**   | 1 byte: Total number of Patch messages that will follow (including this one). For a single-patch update, Seq-Count = 1. In Reset, this might also be used to indicate total patches incoming. |
| 3      | **Compression** | 1 byte: Compression code (0 = none).                                                                                                                                                          |
| 4      | **Entry-Bits**  | 1 byte: Number of bits per table entry. QRPv2 typically uses 4 (to allow distances 0–14 + inf), but can be 1 for a simple bitfield. Must be consistent across the whole table.                |
| 5...   | **Data**        | The payload bytes. In a Reset message, this may include the table length (in bytes or slots) if the spec requires; in a Patch message, this is the chunk of table data for the sequence.      |

For QRP **Reset**, the Data field is minimal – it might contain an integer for table length. Some implementations send the table length as a 4-byte little-endian value immediately after Entry-Bits. (E.g., LimeWire’s implementation included “TableSize” and an infinity value in the reset message.) If such a field is expected, send 4 bytes for length and 1 byte for infinity. In our case, if using 1-bit entries, infinity is implicit (0 means no content), so we could potentially omit an explicit infinity byte – but including a placeholder won’t hurt.

For QRP **Patch**, the Data field carries the actual bits of the table. If sending the whole table in one patch, the Data length should equal (Entry-Bits \* TableSlots) / 8 (rounded up). For example, 65,536 slots @ 1 bit each = 65536/8 = 8192 bytes. The receiver will read this and fill the table from slot 0 up. (If multiple patches were used, each patch might carry a contiguous segment of the table, but we can avoid that complexity.)

## Minimal Implementation Outline (Leaf-Side)

Below is a step-by-step pseudocode for integrating QRPv2 into a leaf-mode client, focusing on the handshake and initial QRP table transmission:

1. **During Handshake:** send `X-Query-Routing: 0.2` along with `X-Ultrapeer: False` in the GNUTELLA/0.6 connect request. Verify the response is `200 OK`. If a 503 is received instead (meaning the Ultrapeer rejected us, possibly due to no QRP), log this and abort or retry with another host.

2. **Prepare QRP Table Data:** Once connected, build the query routing table from the client’s shared files. Pseudocode:

```typescript
const TABLE_SLOTS = 65536;               // number of entries (64 Ki)
const ENTRY_BITS = 1;                   // we'll use 1-bit per slot for simplicity
let qrtBits = new BitArray(TABLE_SLOTS); // initialize all bits to 0 (meaning "no file for that keyword")

// Populate the bit array by hashing keywords of shared files
for (let file of sharedFiles) {
    let keywords = tokenizeFileName(file.name);  // split filename into words
    for (let word of keywords) {
        let norm = normalizeKeyword(word);       // lowercase, remove accents/punctuation:contentReference[oaicite:26]{index=26}
        if (norm.length < 1) continue;
        let index = hash(norm) % TABLE_SLOTS;    // compute slot index (using agreed hash func)
        qrtBits.set(index, 1);                   // mark that slot as having at least one keyword
    }
}
```

*Normalization:* ensure `normalizeKeyword` does things like `word.toLowerCase()` and replacing accented letters with plain ASCII (e.g. é→e). This matches how other Gnutella clients hash keywords, so your indices align with theirs.
*Hash:* you can implement the same hash as in the Gnutella spec – for example, one approach is to treat the normalized word as a big-endian integer, multiply by a large constant, and take the high 16 bits of the result as the index. For illustration, a simple but effective choice could be a 32-bit FNV-1a hash truncated to 16 bits. Consistency is more important than cryptographic quality here.

3. **Send RouteTableUpdate Reset:** Immediately after handshake (or as soon as your table is ready), send a Reset message to the Ultrapeer to start the QRP update sequence. Construct the payload as follows (fields in bytes):

   * Variant = 0x0 (Reset)
   * Seq-No = 0x00 (could be 0 for reset message)
   * Seq-Count = 0x01 (we plan to send 1 patch message)
   * Compression = 0x00 (no compression)
   * Entry-Bits = 0x01 (we’re using 1-bit entries; if we were using 4-bit, this would be 0x04)
   * (Optionally) Table Length = 0x00 0x01 0x00 0x00 (65536 in little-endian = 0x00010000).
   * (Optionally) Infinity value = 0x00 (for 1-bit tables, “no content” is 0).

   Put this into the Gnutella message header format (descriptor ID 0x30, payload length set accordingly) and send it. This tells the Ultrapeer to allocate a new QRT of 65536 bits initialized to all zeros (no keywords yet).

4. **Send RouteTableUpdate Patch:** Next, transmit the actual table bits in a Patch message. Since our table is 8192 bytes, we can send it as one patch. Payload fields:

   * Variant = 0x1 (Patch)
   * Seq-No = 0x01 (this is patch #1)
   * Seq-Count = 0x01 (total number of patches is 1)
   * Compression = 0x00 (none)
   * Entry-Bits = 0x01 (must match what was sent in Reset)
   * Data = 8192 bytes of the bit array (in order from slot 0 to 65535).

   Ensure the Gnutella message header for this RouteTableUpdate has the correct payload length (8192 + 5 bytes of header = 8197 bytes). Send it to the Ultrapeer.

5. **Verification:** No explicit ACK is defined for QRP updates, but you can monitor the connection to ensure the Ultrapeer doesn’t drop us. If the Ultrapeer remains connected and starts sending queries (within a few seconds), it likely accepted our QRP table. It will now **“shield” the leaf** by only forwarding queries that pass the QRP filter (i.e. queries containing at least one keyword that hashed to each of the set bits). All other query traffic is filtered out upstream, reducing our bandwidth load.

6. **Maintaining QRP:** For a minimal implementation, you might choose not to update the QRP table frequently. However, best practice is to update whenever your shared files change (files added/removed). You can compute a new bitset and send **incremental patches**. Typically, you would diff the new table against the old one and send patches for the changed portions. But in a pinch, you can also resend the whole table (Reset + full Patch) if changes are infrequent. Ultrapeers are accustomed to periodic QRP updates from leaves as their shares change. Just avoid doing it too often (e.g. not more than once every few minutes) to prevent unnecessary overhead.

## Additional Notes

* **Dynamic Querying (DQ):** No special implementation is required on the leaf for DQ – it is handled by the querying Ultrapeer. Just be aware that Ultrapeers might send queries with TTL=1 to a subset of connections and then gradually increase TTL (this is the DQ behavior). As a leaf, your role is simply to respond to queries you do receive with the normal QueryHit messages. QRP indirectly assists DQ by ensuring the Ultrapeer knows which leaves to query first (those whose QRP indicate possible matches).
* **Ultrapeer QRP vs Leaf QRP:** This spec focused on the leaf side. Ultrapeers themselves also merge QRP tables from leaves and may exchange **compressed, merged QRP** with other ultrapeers (though in practice Gnutella ultrapeers often did *not* forward full QRP tables to each other to save bandwidth). As a leaf, you do not need to implement any handling of incoming QRP messages from an Ultrapeer – you will not receive any, since leaves don’t forward queries further.
* **Testing:** To verify correctness, connect your client to a known Ultrapeer. After handshake and QRP exchange, attempt searches from another client for files you have and files you don’t. The Ultrapeer should route queries for existing content to you (you’ll see Query packets) and filter out queries for content you truly don’t have (no Queries for those should arrive). Also, inspect handshake logs to ensure no 503 errors.

By implementing the above minimal QRPv2 support, your TypeScript Gnutella client will comply with Ultrapeer expectations and smoothly join the network as a shielded leaf. It will send a correct QRP header and a basic Bloom-filter table (even if mostly empty), allowing Ultrapeers to **“shield” your node from irrelevant query traffic** while still forwarding relevant searches your way. This satisfies the protocol requirements without delving into the complexities of full dynamic query algorithms or advanced QRP optimizations.

**Sources:** QRP and Ultrapeer specifications, Gnutella 0.6 RFC draft and dev forum docs, and historical analyses of query routing.
