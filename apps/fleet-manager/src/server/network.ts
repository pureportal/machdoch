import { isIP } from "node:net";

interface ClientAddressRequest {
  headers: { [name: string]: string | string[] | undefined };
  socket: { remoteAddress?: string };
}

export function requestClientAddress(request: ClientAddressRequest): string {
  const directAddress = normalizeIpAddress(request.socket.remoteAddress);
  if (!directAddress || !isLoopbackAddress(directAddress)) {
    return directAddress ?? "unknown";
  }
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded)
    ? forwarded.at(-1)
    : forwarded;
  const candidate = forwardedValue?.split(",").at(-1);
  return normalizeIpAddress(candidate) ?? directAddress;
}

export function isLoopbackAddress(value: string): boolean {
  const address = normalizeIpAddress(value);
  if (!address) return false;
  if (isIP(address) === 4) return address.startsWith("127.");
  if (address === "::1") return true;
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/iu.exec(
    address,
  )?.[1];
  return mappedIpv4 ? Number.parseInt(mappedIpv4, 16) >> 8 === 127 : false;
}

function normalizeIpAddress(value: string | undefined): string | null {
  const candidate = value?.trim().replace(/^\[|\]$/gu, "");
  if (!candidate || isIP(candidate) === 0) return null;
  if (isIP(candidate) === 4) return candidate;
  try {
    return new URL(`http://[${candidate}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}
