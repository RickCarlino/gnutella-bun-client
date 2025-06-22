import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("cache.ts", () => {
  let server: Bun.Subprocess;
  const baseUrl = "http://localhost:3211";

  beforeEach(async () => {
    server = Bun.spawn(["bun", "./src/cache-server.ts"], {
      env: { ...process.env, PORT: "3211", TEST_MODE: "true" },
    });
    await Bun.sleep(200); // Give server more time to start
  });

  afterEach(() => {
    server?.kill();
  });

  describe("HTTP API", () => {
    test("returns 405 for non-GET requests", async () => {
      const response = await fetch(baseUrl, { method: "POST" });
      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method not allowed");
    });

    test("returns HTML index for no parameters", async () => {
      const response = await fetch(baseUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html");
      const html = await response.text();
      expect(html).toContain("GWebCache");
      expect(html).toContain("LastCache");
    });

    test("handles ping request", async () => {
      const response = await fetch(`${baseUrl}/?ping=1`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|pong|LastCache 1.0|gnutella-gnutella2");
    });

    test("returns 503 for unsupported network", async () => {
      const response = await fetch(`${baseUrl}/?net=bitcoin&get=1`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Required network not accepted");
    });

    test("handles IP update", async () => {
      const response = await fetch(`${baseUrl}/?ip=8.8.8.8:6346&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|update|OK");
    });

    test("handles URL update", async () => {
      const response = await fetch(
        `${baseUrl}/?url=http://example.com/cache.php&net=gnutella`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|update|OK");
    });

    test("handles invalid IP format in update", async () => {
      const response = await fetch(`${baseUrl}/?ip=invalid&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|update|WARNING|Invalid IP format");
    });

    test("handles get request with hosts", async () => {
      await fetch(`${baseUrl}/?ip=8.8.8.8:6346&net=gnutella`);
      const response = await fetch(`${baseUrl}/?get=1&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/H\|8\.8\.8\.8:6346\|\d+/);
    });

    test("handles get request with caches", async () => {
      await fetch(`${baseUrl}/?url=http://example.com/cache.php&net=gnutella`);
      const response = await fetch(`${baseUrl}/?get=1&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/U\|http:\/\/example\.com\/cache\.php\|\d+/);
    });

    test("handles update and get in single request", async () => {
      const response = await fetch(
        `${baseUrl}/?ip=8.8.8.8:6346&get=1&net=gnutella`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|update|OK");
      expect(text).toMatch(/H\|8\.8\.8\.8:6346\|\d+/);
    });

    test("handles cluster parameter", async () => {
      await fetch(
        `${baseUrl}/?ip=8.8.8.8:6346&cluster=testcluster&net=gnutella`,
      );
      const response = await fetch(
        `${baseUrl}/?get=1&getclusters=1&net=gnutella`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/H\|8\.8\.8\.8:6346\|\d+\|testcluster/);
    });

    test("defaults to gnutella network", async () => {
      const response = await fetch(`${baseUrl}/?get=1`);
      expect(response.status).toBe(200);
    });

    test("handles gnutella2 network", async () => {
      await fetch(`${baseUrl}/?ip=8.8.8.8:6346&net=gnutella2`);
      const response = await fetch(`${baseUrl}/?get=1&net=gnutella2`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/H\|8\.8\.8\.8:6346\|\d+/);
    });

    test("separates hosts by network", async () => {
      await fetch(`${baseUrl}/?ip=8.8.8.8:6346&net=gnutella`);
      await fetch(`${baseUrl}/?ip=8.8.4.4:6346&net=gnutella2`);

      const response1 = await fetch(`${baseUrl}/?get=1&net=gnutella`);
      const text1 = await response1.text();
      expect(text1).toContain("8.8.8.8");
      expect(text1).not.toContain("8.8.4.4");

      const response2 = await fetch(`${baseUrl}/?get=1&net=gnutella2`);
      const text2 = await response2.text();
      expect(text2).toContain("8.8.4.4");
      expect(text2).not.toContain("8.8.8.8");
    });

    test("handles x-forwarded-for header", async () => {
      const response = await fetch(`${baseUrl}/?ping=1`, {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });
      expect(response.status).toBe(200);
    });

    test("rate limiting allows first request", async () => {
      const response = await fetch(`${baseUrl}/?get=1`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("You came back too early");
    });

    test("update requests bypass rate limiting", async () => {
      await fetch(`${baseUrl}/?get=1`);
      const response = await fetch(`${baseUrl}/?ip=8.8.8.8:6346`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("You came back too early");
    });
  });

  describe("Edge cases", () => {
    test("handles empty host list", async () => {
      const response = await fetch(`${baseUrl}/?get=1&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.trim()).toBe("");
    });

    test("handles multiple updates in single request", async () => {
      const response = await fetch(
        `${baseUrl}/?ip=8.8.8.8:6346&url=http://example.com&net=gnutella`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const lines = text.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("I|update|OK");
      expect(lines[1]).toContain("I|update|OK");
    });

    test("handles ping with get request", async () => {
      await fetch(`${baseUrl}/?ip=8.8.8.8:6346&net=gnutella`);
      const response = await fetch(`${baseUrl}/?ping=1&get=1&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("I|pong|");
      expect(text).toMatch(/H\|8\.8\.8\.8:6346\|\d+/);
    });

    test("handles update parameter without actual updates", async () => {
      const response = await fetch(`${baseUrl}/?update=1&get=1`);
      expect(response.status).toBe(200);
    });

    test("handles cluster without getclusters parameter", async () => {
      await fetch(
        `${baseUrl}/?ip=8.8.8.8:6346&cluster=testcluster&net=gnutella`,
      );
      const response = await fetch(`${baseUrl}/?get=1&net=gnutella`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("testcluster");
    });
  });
});
