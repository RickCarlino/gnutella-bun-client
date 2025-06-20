# Implementing Deflate Compression in a Gnutella 0.6 Client (TypeScript/Bun)

## Negotiating Compression During the Handshake

Gnutella 0.6 uses an HTTP-like handshake where peers exchange capability headers. To support compression, you must advertise and agree on it during this handshake phase:

- **Client Request (GNUTELLA CONNECT/0.6):** Include an `Accept-Encoding: deflate` header if your client supports decompression. This tells the remote peer that you can receive (and decompress) deflated data. For example:

  ```text
  GNUTELLA CONNECT/0.6
  User-Agent: MyClient/1.0
  Accept-Encoding: deflate
  [Other headers...]
  ```

- **Server Response (GNUTELLA/0.6 200 OK):** If the remote peer also supports compression and sees your `Accept-Encoding`, it should respond with `Content-Encoding: deflate` to confirm that it will send compressed data. This header **acknowledges the requested compression**. The server may also include its own `Accept-Encoding: deflate` in the response, indicating it can accept compressed data from you as well. For example:

  ```text
  GNUTELLA/0.6 200 OK
  Content-Encoding: deflate
  Accept-Encoding: deflate
  [Other headers...]
  ```

- **Final Handshake Acknowledgment:** Your client should then send the final handshake line (`GNUTELLA/0.6 200 OK` with no additional headers) to conclude the handshake. The handshake messages themselves are always in plain text (not compressed). Compression begins **after** the handshake is successfully negotiated.

**Notes:**

- Always include `Accept-Encoding: deflate` in your handshake if you support it. Some modern servents expect this header and may refuse connections if it’s missing. (E.g. gtk-gnutella requires the `Accept-Encoding` header in the handshake.) Including it maximizes compatibility.
- The `Accept-Encoding` header can list multiple algorithms (e.g. `gzip` or others), but deflate is the de-facto standard on Gnutella. To keep things simple, advertise and handle **deflate** compression, which is implemented using zlib.
- If the peer does **not** support compression, it simply won’t include `Content-Encoding` in its response. In that case, both sides will continue uncompressed as usual. Your implementation should detect the absence of `Content-Encoding: deflate` and refrain from compressing data to that peer.

## Compressing and Decompressing Payloads with zlib (Deflate)

Once compression is agreed upon, all Gnutella message payloads sent over the TCP stream should be compressed (deflated) or decompressed (inflated) on the fly. In the Bun runtime (which is largely Node.js-compatible), you can use the **zlib** library to handle deflate compression:

- **Using zlib in Bun:** Import the Node zlib API (Bun supports Node’s `zlib` module). For example:

  ```ts
  import { createDeflate, createInflate } from "node:zlib";
  ```

  This gives you streaming compression objects for deflate.

- **Create compression streams:** Initialize a deflate stream for outgoing data and an inflate stream for incoming data:

  ```ts
  const deflator = createDeflate(); // for compressing outgoing messages
  const inflator = createInflate(); // for decompressing incoming data
  ```

  These objects are Transform streams that you can write data to and read compressed/decompressed data from. Using streams allows continuous processing of the connection’s data.

- **Compressing outgoing data:** When sending a Gnutella message (after the handshake), write the message’s byte buffer to the deflate stream instead of directly to the socket. The deflator will emit compressed bytes. For example:

  ```ts
  deflator.write(messageBuffer);
  deflator.flush(); // optional: flush to ensure all data is output promptly
  ```

  You can listen to the deflate stream’s `"data"` event or pipe it to the socket to actually send the compressed bytes:

  ```ts
  deflator.on("data", (compressedChunk) => {
    socket.write(compressedChunk);
  });
  ```

- **Decompressing incoming data:** Similarly, data coming from the socket should be fed into the inflate stream. The inflator will emit decompressed (original) bytes that your existing parser can understand. For example:

  ```ts
  socket.on("data", (chunk) => {
    inflator.write(chunk);
  });
  inflator.on("data", (decompressedChunk) => {
    handleIncomingData(decompressedChunk); // process as normal Gnutella message bytes
  });
  ```

  The inflate stream will internally buffer and decompress the deflate stream from the peer. Once set up, your higher-level code doesn’t need to worry about compression – it will receive plain decoded data.

- **Use standard deflate:** Ensure you use standard DEFLATE (zlib format) for compatibility. The Gnutella network’s compression is standardized on deflate as implemented by zlib (the same format used in HTTP’s deflate content-encoding). You do **not** need to use raw deflate or gzip; the handshake specifically negotiated “deflate”.

- **Stream continuity:** Treat the connection as a continuous deflate stream. Do not reset or reinitialize the zlib stream for each message – keep it open for the life of the connection so it can handle arbitrarily large or multiple messages in sequence. The inflate/deflate streams will handle chunking internally.

- **Flushing:** To reduce latency, you may flush the deflator after sending each message or important chunk. For example, using `deflator.flush(zlib.constants.Z_SYNC_FLUSH)` can ensure the compressed data is output immediately. This can be helpful because small messages might otherwise sit in the deflator’s buffer. Be mindful that excessive flushing can reduce compression efficiency, but it improves real-time responsiveness.

## Wrapping the Socket Stream After Handshake

To apply compression, you effectively **wrap** the socket’s I/O streams with the zlib transformers after the handshake is complete:

1. **Determine if compression is enabled:** Once the handshake exchange is done, inspect the headers. If either the peer’s response included `Content-Encoding: deflate` (or if you as server sent it), mark this connection as `compressed=true`. This flag indicates that all subsequent traffic on this socket will be compressed.

2. **Attach inflate to incoming data:** Modify your socket’s data handling so that if `compressed=true`, incoming bytes are funneled through the inflate stream. In practice, you can pipe the socket to the inflator, or manually write socket data into the inflator as shown above. The inflator’s output should feed into your existing buffer parser. This **unwraps** the compressed stream back into normal Gnutella messages.

3. **Attach deflate to outgoing data:** Likewise, override the sending mechanism for this connection. If `compressed=true`, do not write directly to the socket. Instead, write through the deflator and then send the compressed bytes emitted. You can pipe the deflator into the socket, or handle the `"data"` event on the deflator to forward data to the socket. This wrapping ensures that anything you send is automatically compressed before it hits the network.

4. **Preserve existing parsing logic:** After wrapping, your higher-level logic (message parsers, etc.) should continue to work with no modifications. They will receive a stream of decompressed bytes as if it were a normal uncompressed connection. Gnutella message boundaries and formats don’t change – you still have the 23-byte message header (descriptor) followed by the payload, etc., but now those bytes arrive via the inflater. Ensure that you continue to accumulate data into your buffer and parse messages as usual once decompressed.

5. **Start compression after the handshake:** Do not compress the handshake messages themselves. Only enable the deflate/inflate wrapping _after_ the handshake is successfully concluded (i.e., after the 200 OK exchange). Both sides will then switch to compressed mode for all Gnutella messages. Typically, the first message after the handshake (e.g., a Ping or Query) will be the first compressed data on the stream.

6. **Cleanup:** On connection close or error, make sure to properly end/close the zlib streams. For example, call `deflator.end()` to flush any remaining data to the socket, and call `inflator.end()` if needed. This ensures all data is processed and resources are freed. Also handle `error` events on these streams (e.g., if decompression fails due to corrupt data, you should drop the connection as it’s no longer reliable).

By wrapping the socket’s read/write in this manner, you encapsulate compression at the transport level. The rest of your client (routing messages, responding to pings, etc.) can remain unaware of whether the connection is compressed or not.

## Compatibility: Fallback for Peers Without Compression

Not all Gnutella peers will support deflate compression (especially legacy clients). Your implementation should gracefully handle these cases:

- **Detection of non-support:** If the handshake response does **not** include `Content-Encoding: deflate`, assume the peer expects an uncompressed connection. In this case, do not wrap the socket with zlib. Continue sending and receiving raw data as you normally would. The presence or absence of the header is the trigger – do not attempt compression unless it’s explicitly agreed upon.

- **No `Accept-Encoding` from peer:** Similarly, if you are acting as the server and the incoming handshake from the remote client does not have `Accept-Encoding: deflate`, then they likely cannot decompress data. You should **not** send `Content-Encoding` in your response (since they didn’t ask for it), and you should refrain from compressing your outbound messages to that peer. Simply omit the compression header and proceed uncompressed.

- **Automatic fallback:** Design your handshake handler such that compression is **opt-in**. If either side doesn’t support it, the connection remains in plain mode. For example, you might set `compressed=true` only if _both_ you indicated support and the peer acknowledged it. If the negotiation isn’t mutual, default to no compression.

- **Older protocol versions:** Gnutella 0.4 peers won’t understand these headers at all. If your client ever connects to a GNUTELLA CONNECT/0.4 handshake, you must not send new 0.6 headers (including `Accept-Encoding`). In practice, if your client only speaks 0.6, this may not occur. But be aware of protocol version when adding headers.

- **Performance considerations:** If a peer doesn’t support compression, you lose the bandwidth savings but everything still functions. Ensure your code doesn’t assume `inflator`/`deflator` objects are always there – those should be initialized only for compressed connections. For non-compressed links, continue using the existing logic with no zlib transforms.

## Interoperability with Compression-Enforcing Peers

On today’s Gnutella network, many Ultrapeers strongly prefer or even **require** compression for bandwidth efficiency. It's important to handle these scenarios:

- **Peers that require compression:** Some Ultrapeers will refuse connections from clients that do not support deflate. This is indicated by a handshake error code **403: "Gnet connection not compressed"**. In measured network traffic, a large number of handshake rejections use this code, meaning the client was rejected because it didn't compress the connection. By advertising and using compression, your client avoids these rejections.

- **Handling a 403 response:** If you do encounter a `GNUTELLA/0.6 403 Gnet connection not compressed` during the handshake, the remote peer has aborted the connection due to lack of compression. The only remedy is to reconnect with compression enabled. In practice, if you implement the handshake as described (always send `Accept-Encoding: deflate` and handle `Content-Encoding`), you should not get a 403 from modern peers. Should it occur, log it and treat it as a failed connection attempt. (Your client might mark that peer or try again, but that’s up to your peer selection logic.)

- **Peers that enforce compression after handshake:** Once compression is negotiated, both sides are expected to use it. If, for example, you indicated support but then continue to send uncompressed data, some peers might drop the connection or send an error (they might consider it a protocol violation). Thus, when `Content-Encoding: deflate` has been agreed, **always compress your outgoing messages**. Likewise, be prepared to decompress anything incoming after that point. Consistency is key.

- **Asymmetric compression:** The Gnutella protocol technically allows asymmetrical compression (one direction compressed, the other not), but in practice this is rarely used. Almost all clients that support deflate will compress in both directions when possible. Our implementation will handle both directions if negotiated. (If a peer were to send `Content-Encoding: deflate` but not accept encoding, it means they’ll compress data to you but expect you not to compress to them – your client should respect that and only decompress incoming data. This is unusual, however.)

- **Testing interoperability:** It’s wise to test your client against known Ultrapeers (e.g., WireShare, gtk-gnutella, Phex, etc.) to ensure that the handshake succeeds and that compressed messages are exchanged. Monitor the handshake headers to confirm that `Accept-Encoding` and `Content-Encoding` are present as expected, and use a network sniffer to verify that after handshake the traffic is indeed compressed (it will look like binary gibberish, not recognizable Gnutella messages, if compression is working).

By implementing compression, your client will not only save bandwidth but also be accepted by the majority of modern Gnutella peers. It avoids the dreaded 403 error and interoperates with peers that mandate compression for connections.

## Integration with Existing Buffer and Socket Handling Architecture

Finally, integrate these changes into your client’s TypeScript code, which already handles message parsing, QRP, etc. Key points of integration:

- **Handshake Handler:** Augment your handshake routines to include the `Accept-Encoding: deflate` header in outgoing connects. Parse incoming handshake lines for `Accept-Encoding` and `Content-Encoding`. You likely have a handshake parser that reads lines into a map of headers – extend it to check for these headers (e.g., `if (headerName === "Accept-Encoding") remoteSupportsDeflate = true;`). If you see `Content-Encoding: deflate` in the peer’s response, set a flag like `connection.compressed = true`. Also note if the peer sent `Accept-Encoding: deflate` back, which means you **can** compress your sends to them.

- **Connection State:** Add a property to your connection descriptor/structure to indicate compression status (e.g., `isCompressed` or similar). This flag should be determined right after the handshake. Also store the zlib stream objects in the connection state, for example:

  ```ts
  connection.inflator = compressed ? createInflate() : null;
  connection.deflator = compressed ? createDeflate() : null;
  connection.isCompressed = compressed;
  ```

  This allows the rest of the code to easily check and use the appropriate streams.

- **Buffer Processor Integration:** Your client likely has a buffer processing loop that accumulates bytes from the socket and tries to parse complete messages (based on the Gnutella message length field in the header). To integrate compression, modify the point where data is read from the socket:

  - If `connection.isCompressed` is false, continue as normal: append data directly to the input buffer and run the parser.
  - If `connection.isCompressed` is true, route the data through the inflator first. For example, instead of `socket.on('data', buf => bufferProcessor.add(buf))`, do:

    ```ts
    socket.on("data", (buf) => {
      if (!connection.isCompressed) {
        bufferProcessor.add(buf);
      } else {
        connection.inflator.write(buf);
      }
    });
    connection.inflator.on("data", (decompressedBuf) => {
      bufferProcessor.add(decompressedBuf);
    });
    ```

    In this scheme, the existing `bufferProcessor` (which handles assembling messages) receives only decompressed data. It doesn’t need to know that compression was in effect – it sees the same byte stream it would have seen in an uncompressed scenario. This keeps your parsing logic unchanged. The Gnutella message descriptor (23-byte header) and payload will appear in the buffer in order once decompressed, just as before.

- **Socket Writing (Message Sender):** Likewise, adapt your sending function. Suppose you have a method `connection.send(messageBytes)` that normally does `socket.write(messageBytes)`. Change it to:

  ```ts
  if (!connection.isCompressed) {
    socket.write(messageBytes);
  } else {
    connection.deflator.write(messageBytes);
  }
  ```

  And ensure the deflator’s output is wired to the socket:

  ```ts
  connection.deflator.on("data", (compressedChunk) => {
    socket.write(compressedChunk);
  });
  ```

  You might set up this `.on('data')` listener right after creating the deflator during handshake. This way, any time you write to `connection.deflator`, the compressed result is automatically forwarded to the socket. (In Bun/Node, you could also `pipeline(connection.deflator, socket)` to pipe the transform to the socket as a writable stream.)

- **Descriptor and Message Handling:** The rest of your message handling (routing replies, QRP processing, TTL/Hops updates, etc.) remains the same. Compression is transparent at that layer. Just be sure that when sending generated messages (like query hits or pings), you go through the `send` function so that data gets compressed if needed. For incoming, by the time a message reaches your descriptor handler (the code that interprets the Gnutella message header and payload), it’s already decompressed and ready for normal processing.

- **Edge cases and errors:** Monitor for any zlib errors. For example, if `inflator` emits an `'error'` event (which could happen if the stream is corrupted or the peer sends invalid data), handle it by closing that connection – this is analogous to detecting a protocol violation. Also consider timeouts or logic to handle if compression was expected but no data arrives (not likely, but in case the handshake said compressed and then connection stalls, you might debug with this in mind).

- **Testing:** Since your client already supports Query Routing (QRP) and other features, test with compression on to ensure those still work. QRP and other message exchanges will simply be encapsulated in deflate but function identically. You should verify that after enabling compression, your client can still successfully perform searches, receive pongs, etc., across compressed connections.

By following this guide, you'll add transparent compression support to your Gnutella 0.6 client. The handshake will advertise the capability, the socket will be wrapped with zlib streams after handshake, and your existing architecture will handle the rest of the protocol as usual on the decompressed data. This will make your client more bandwidth-efficient and compatible with peers that expect compressed connections, as evidenced by the significant number of peers enforcing compression on the modern Gnutella network. With these changes, your TypeScript/Bun servent will fully support deflate compression in accordance with Gnutella 0.6 standards.
