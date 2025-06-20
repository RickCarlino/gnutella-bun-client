import * as net from "net";
import { createInflate, createDeflate, Inflate, Deflate } from "node:zlib";
import { createBufferProcessor } from "./buffer-processor";
import { checkCompressionSupport } from "./handshake-utils";
import type { GnutellaObject, HandshakeOk, HandshakeError } from "../parser";

export type CompressedSocketHandlerOptions = {
  socket: net.Socket;
  onMessage: (message: GnutellaObject) => void;
  onError: (error: Error) => void;
  onClose: () => void;
  isServer?: boolean;
};

export interface CompressionState {
  peerAcceptsCompression: boolean;
  peerSendsCompressed: boolean;
  isCompressed: boolean;
  inflator?: Inflate;
  deflator?: Deflate;
}

interface HandshakeState {
  complete: boolean;
  sentConnect?: boolean;
  receivedOk?: boolean;
  sentOk?: boolean;
  waitingForFinalOk?: boolean;
}

export function createCompressedSocketHandler(options: CompressedSocketHandlerOptions): {
  send: (message: Buffer) => void;
  compressionState: CompressionState;
  setCompressionHeaders: (headers: Record<string, string>) => void;
  enableCompression: (sendCompressed: boolean, receiveCompressed: boolean) => void;
  completeHandshake: () => void;
} {
  const { socket, onMessage, onError, onClose, isServer = false } = options;
  
  const processor = createBufferProcessor(onMessage, onError);
  const compressionState: CompressionState = {
    peerAcceptsCompression: false,
    peerSendsCompressed: false,
    isCompressed: false,
  };

  const handshakeState: HandshakeState = {
    complete: false,
  };

  // Function to enable compression based on negotiated headers
  const enableCompression = (sendCompressed: boolean, receiveCompressed: boolean) => {
    compressionState.peerAcceptsCompression = sendCompressed;
    compressionState.peerSendsCompressed = receiveCompressed;
    if (handshakeState.complete) {
      setupCompression();
    }
  };

  // Enhanced message handler that checks for compression headers
  const enhancedOnMessage = (message: GnutellaObject) => {
    // Track handshake state and compression headers
    if (!handshakeState.complete) {
      switch (message.type) {
        case "handshake_ok":
          const okMsg = message as HandshakeOk;
          if (okMsg.headers) {
            // Check if peer will send compressed data to us
            if (okMsg.headers["Content-Encoding"] === "deflate") {
              compressionState.peerSendsCompressed = true;
            }
            // Check if peer accepts compressed data from us
            if (okMsg.headers["Accept-Encoding"]?.includes("deflate")) {
              compressionState.peerAcceptsCompression = true;
            }
          }
          
          if (isServer) {
            // Server: we're receiving the client's final OK after our OK
            if (handshakeState.sentOk && !handshakeState.receivedOk) {
              handshakeState.receivedOk = true;
              handshakeState.complete = true;
              setupCompression();
            }
          } else {
            // Client: we're receiving the server's OK after our connect
            if (handshakeState.sentConnect) {
              handshakeState.receivedOk = true;
              // Don't complete yet - we still need to send our final OK
            }
          }
          break;
          
        case "handshake_connect":
          // Server side: receiving initial connect
          if (checkCompressionSupport(message.headers)) {
            compressionState.peerAcceptsCompression = true;
          }
          handshakeState.sentConnect = true; // Mark that we received a connect
          break;
          
        case "handshake_error":
          handshakeState.complete = true;
          break;
      }
    }
    
    onMessage(message);
  };

  // Setup compression after handshake
  const setupCompression = () => {
    if (!handshakeState.complete) {
      console.log("[Compression] Attempted to setup compression before handshake complete");
      return;
    }
    
    if (compressionState.peerSendsCompressed || compressionState.peerAcceptsCompression) {
      compressionState.isCompressed = true;
      console.log(`[Compression] Enabling compression (recv: ${compressionState.peerSendsCompressed}, send: ${compressionState.peerAcceptsCompression})`);
      
      // Setup inflator if peer sends compressed data
      if (compressionState.peerSendsCompressed) {
        compressionState.inflator = createInflate();
        
        // Route decompressed data to buffer processor
        compressionState.inflator.on("data", (chunk) => {
          processor.process(chunk);
        });
        
        compressionState.inflator.on("error", (err) => {
          onError(new Error(`Decompression error: ${err.message}`));
          socket.destroy();
        });
      }
      
      // Setup deflator if peer accepts compressed data
      if (compressionState.peerAcceptsCompression) {
        compressionState.deflator = createDeflate();
        
        // Route compressed data to socket
        compressionState.deflator.on("data", (chunk) => {
          socket.write(chunk);
        });
        
        compressionState.deflator.on("error", (err) => {
          onError(new Error(`Compression error: ${err.message}`));
          socket.destroy();
        });
      }
    }
  };

  // Handle incoming data
  socket.on("data", (chunk) => {
    if (!handshakeState.complete || !compressionState.inflator) {
      // Before handshake or no compression: process directly
      processor.process(chunk);
    } else {
      // After handshake with compression: route through inflator
      compressionState.inflator.write(chunk);
    }
  });

  socket.on("error", onError);
  
  socket.on("close", () => {
    // Clean up compression streams
    if (compressionState.inflator) {
      compressionState.inflator.end();
    }
    if (compressionState.deflator) {
      compressionState.deflator.end();
    }
    onClose();
  });

  // Create buffer processor with enhanced message handler
  const enhancedProcessor = createBufferProcessor(enhancedOnMessage, onError);
  
  // Replace the processor's process method
  processor.process = enhancedProcessor.process;

  // Send function that routes through deflator if needed
  const send = (message: Buffer) => {
    // Track handshake messages being sent
    if (!handshakeState.complete && message.length > 0) {
      const msgStr = message.toString('utf8', 0, Math.min(50, message.length));
      if (msgStr.includes('GNUTELLA/0.6 200 OK')) {
        handshakeState.sentOk = true;
        // For server: complete handshake after sending OK if we already received client's OK
        if (isServer && handshakeState.receivedOk) {
          handshakeState.complete = true;
          setupCompression();
        }
      } else if (msgStr.includes('GNUTELLA CONNECT')) {
        handshakeState.sentConnect = true;
      }
    }
    
    if (!handshakeState.complete || !compressionState.deflator) {
      // Before handshake or no compression: send directly
      socket.write(message);
    } else {
      // After handshake with compression: route through deflator
      compressionState.deflator.write(message);
      // Flush to ensure timely delivery
      compressionState.deflator.flush();
    }
  };

  // Function to set compression headers for server response
  const setCompressionHeaders = (headers: Record<string, string>) => {
    // If we're a server and the client accepts deflate, we can send compressed
    if (isServer && compressionState.peerAcceptsCompression) {
      headers["Content-Encoding"] = "deflate";
      compressionState.peerSendsCompressed = true;
    }
    // Always advertise that we accept compression
    headers["Accept-Encoding"] = "deflate";
  };

  // Mark handshake as complete when client sends final OK
  const completeHandshake = () => {
    if (!isServer && handshakeState.receivedOk && !handshakeState.complete) {
      handshakeState.complete = true;
      setupCompression();
    }
  };
  
  return { send, compressionState, setCompressionHeaders, enableCompression, completeHandshake };
}