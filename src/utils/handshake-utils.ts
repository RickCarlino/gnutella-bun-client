export function checkCompressionSupport(headers?: Record<string, string>): boolean {
  return headers?.["Accept-Encoding"]?.includes("deflate") || false;
}

export function addCompressionHeaders(
  headers: Record<string, string>,
  acceptsCompression: boolean
): Record<string, string> {
  const responseHeaders = { ...headers };
  
  if (acceptsCompression) {
    responseHeaders["Content-Encoding"] = "deflate";
  }
  
  return responseHeaders;
}