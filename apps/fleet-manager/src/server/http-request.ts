import type { IncomingMessage } from "node:http";

export class IncomingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function incomingRequestUrl(requestTarget: string | undefined): URL {
  try {
    return new URL(requestTarget ?? "/", "http://fleet-manager.invalid");
  } catch {
    throw new IncomingRequestError(400, "Request URL is invalid.");
  }
}

export async function createWebRequest(
  request: IncomingMessage,
  externalBaseUrl: string,
  maximumBodyBytes: number,
): Promise<Request> {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value) headers.append(name, value);
  }
  const incomingUrl = incomingRequestUrl(request.url);
  const url = new URL(externalBaseUrl);
  url.pathname = incomingUrl.pathname;
  url.search = incomingUrl.search;
  const method = request.method ?? "GET";
  if (["CONNECT", "TRACE", "TRACK"].includes(method.toUpperCase())) {
    throw new IncomingRequestError(405, "Request method is not supported.");
  }
  const body = await readRequestBody(request, maximumBodyBytes);
  if ((method === "GET" || method === "HEAD") && body.byteLength > 0) {
    throw new IncomingRequestError(
      400,
      `${method} requests must not include a body.`,
    );
  }
  return new Request(url, {
    method,
    headers,
    body: body.byteLength === 0 ? undefined : new Uint8Array(body),
  });
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBodyBytes: number,
): Promise<Buffer> {
  const contentLengthValue = request.headers["content-length"];
  const contentLength = Number(contentLengthValue);
  if (
    contentLengthValue !== undefined &&
    (!Number.isSafeInteger(contentLength) || contentLength < 0)
  ) {
    throw new IncomingRequestError(400, "Content-Length is invalid.");
  }
  if (contentLength > maximumBodyBytes) {
    throw new IncomingRequestError(413, "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBodyBytes) {
      throw new IncomingRequestError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}
