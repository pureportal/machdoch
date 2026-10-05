export async function createFleetSessionId(commandId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(commandId),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const identifier = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${identifier.slice(0, 8)}-${identifier.slice(8, 12)}-${identifier.slice(12, 16)}-${identifier.slice(16, 20)}-${identifier.slice(20, 32)}`;
}
