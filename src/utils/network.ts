/**
 * Network utility functions
 */

/**
 * Attempt to get the public IP address
 * Uses multiple services for redundancy
 */
export async function getPublicIP(): Promise<string> {
  const services = [
    "https://api.ipify.org?format=text",
    "https://icanhazip.com",
    "https://checkip.amazonaws.com",
    "https://wtfismyip.com/text",
  ];

  for (const service of services) {
    const response = await fetch(service, {
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (response.ok) {
      const ip = (await response.text()).trim();

      // Basic validation
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        return ip;
      }
    }
  }

  throw new Error("Could not determine public IP address");
}
