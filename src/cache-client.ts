import { HOUR } from "./const";

/**
 * GWebCacheClient handles communication with GWebCache servers
 * Supports both Spec 1 (Gnutella 0.6) and Spec 2 (Gnutella2) response formats
 */
export class GWebCacheClient {
  private readonly userAgent: string;
  private readonly clientVersion: string;
  private readonly clientCode: string;

  constructor(clientCode: string = "BUNT", clientVersion: string = "0.1.0") {
    this.clientCode = clientCode;
    this.clientVersion = clientVersion;
    this.userAgent = `GnutellaBun/${clientVersion}`;
  }

  /**
   * Fetch peers and caches from a GWC server
   * Respects rate limiting and handles both spec 1 and spec 2 formats
   */
  async fetchPeersAndCaches(
    cacheUrl: string,
    network: "gnutella" | "gnutella2" = "gnutella",
  ): Promise<{
    peers: Array<{ ip: string; port: number }>;
    caches: string[];
  }> {
    const url = new URL(cacheUrl);

    // Add query parameters for spec 2 format (also works with spec 1)
    url.searchParams.set("get", "1");
    url.searchParams.set("net", network);
    url.searchParams.set("client", this.clientCode);
    url.searchParams.set("version", this.clientVersion);
    url.searchParams.set("ping", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      // Handle specific GWC errors
      if (response.status === 503) {
        const text = await response.text();
        if (text.includes("Required network not accepted")) {
          throw new Error(`Cache does not support ${network} network`);
        }
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    return this.parseResponse(text);
  }

  /**
   * Submit our node to a GWC server
   */
  async submitHost(
    cacheUrl: string,
    ourIp: string,
    ourPort: number,
    network: "gnutella" | "gnutella2" = "gnutella",
  ): Promise<boolean> {
    const url = new URL(cacheUrl);

    // Add update parameters
    url.searchParams.set("update", "1");
    url.searchParams.set("ip", `${ourIp}:${ourPort}`);
    url.searchParams.set("net", network);
    url.searchParams.set("client", this.clientCode);
    url.searchParams.set("version", this.clientVersion);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    return this.parseUpdateResponse(text);
  }

  /**
   * Parse response text, automatically detecting spec 1 or spec 2 format
   */
  private parseResponse(text: string): {
    peers: Array<{ ip: string; port: number }>;
    caches: string[];
  } {
    const lines = text.trim().split(/\r?\n/);
    const peers: Array<{ ip: string; port: number }> = [];
    const caches: string[] = [];

    // Check if this is spec 2 format (lines start with I|, H|, U|)
    const isSpec2 = lines.some((line) => /^[IHU]\|/.test(line));

    if (isSpec2) {
      this.parseSpec2Response(lines, peers, caches);
    } else {
      this.parseSpec1Response(lines, peers, caches);
    }

    return { peers, caches };
  }

  /**
   * Parse spec 2 format response
   */
  private parseSpec2Response(
    lines: string[],
    peers: Array<{ ip: string; port: number }>,
    caches: string[],
  ): void {
    for (const line of lines) {
      if (line.startsWith("H|")) {
        // Host line: H|IP:port|age
        const parts = line.split("|");
        if (parts.length >= 3) {
          const [ip, portStr] = parts[1].split(":");
          const port = parseInt(portStr, 10);
          if (this.isValidHost(ip, port)) {
            peers.push({ ip, port });
          }
        }
      } else {
        if (line.startsWith("U|")) {
          // URL line: U|http://cache.url|age
          const parts = line.split("|");
          if (parts.length >= 3 && this.isValidCacheUrl(parts[1])) {
            caches.push(parts[1]);
          }
        } else {
          if (line.startsWith("I|WARNING|")) {
            // Log warnings but don't fail
            console.warn(`GWC warning: ${line}`);
          }
        }
      }
    }
  }

  /**
   * Parse spec 1 format response
   */
  private parseSpec1Response(
    lines: string[],
    peers: Array<{ ip: string; port: number }>,
    caches: string[],
  ): void {
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and PONG lines
      if (!trimmed || trimmed.startsWith("PONG")) {
        continue;
      }

      // Check for status messages
      if (
        trimmed === "OK" ||
        trimmed.startsWith("WARNING:") ||
        trimmed.startsWith("OKWARNING:")
      ) {
        continue;
      }

      // Try to parse as host (IP:port)
      const hostMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
      if (hostMatch) {
        const ip = hostMatch[1];
        const port = parseInt(hostMatch[2], 10);
        if (this.isValidHost(ip, port)) {
          peers.push({ ip, port });
        }
      } else {
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          // Parse as cache URL
          if (this.isValidCacheUrl(trimmed)) {
            caches.push(trimmed);
          }
        }
      }
    }
  }

  /**
   * Parse update response to determine if submission was successful
   */
  private parseUpdateResponse(text: string): boolean {
    const lines = text.trim().split(/\r?\n/);

    for (const line of lines) {
      // Spec 2 format
      if (line.startsWith("I|update|")) {
        return line.includes("OK");
      }
      // Spec 1 format
      if (line === "OK" || line.startsWith("OKWARNING:")) {
        return true;
      }
      if (line.startsWith("WARNING:") && !line.startsWith("OKWARNING:")) {
        console.warn(`GWC update warning: ${line}`);
        return false;
      }
    }

    // If no explicit status, assume success if we got a 200 response
    return true;
  }

  /**
   * Validate IP address and port
   */
  private isValidHost(ip: string, port: number): boolean {
    // Validate port range
    if (port < 1 || port > 65535) {
      return false;
    }

    // Parse IP parts
    const parts = ip.split(".");
    if (parts.length !== 4) {
      return false;
    }

    const octets = parts.map((p) => parseInt(p, 10));
    if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
      return false;
    }

    // Reject private/reserved IP ranges
    // 10.0.0.0/8
    if (octets[0] === 10) {
      return false;
    }
    // 172.16.0.0/12
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return false;
    }
    // 192.168.0.0/16
    if (octets[0] === 192 && octets[1] === 168) {
      return false;
    }
    // 127.0.0.0/8 (loopback)
    if (octets[0] === 127) {
      return false;
    }
    // 0.0.0.0/8
    if (octets[0] === 0) {
      return false;
    }
    // 169.254.0.0/16 (link-local)
    if (octets[0] === 169 && octets[1] === 254) {
      return false;
    }
    // 224.0.0.0/4 (multicast)
    if (octets[0] >= 224 && octets[0] <= 239) {
      return false;
    }
    // 240.0.0.0/4 (reserved)
    if (octets[0] >= 240) {
      return false;
    }

    return true;
  }

  /**
   * Validate cache URL
   */
  private isValidCacheUrl(url: string): boolean {
    const parsed = new URL(url);
    // Only accept HTTP/HTTPS
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    // Must have a hostname
    if (!parsed.hostname) {
      return false;
    }
    // Reject localhost/local addresses
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".local")
    ) {
      return false;
    }
    return true;
  }

  /**
   * Check if enough time has passed since last query
   * This should be implemented by the caller using SettingStore
   */
  canQueryCache(lastQueryTime: number): boolean {
    return Date.now() - lastQueryTime >= HOUR;
  }
}
