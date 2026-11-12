import { z } from "zod";
import { CloudError } from "./access";

export async function readRawBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new CloudError(400, "invalid_json", "Request body is missing.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CloudError(413, "body_too_large", "Request is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    throw new CloudError(415, "json_required", "Send this request as JSON.");
  const body = await readRawBody(request, maxBytes);
  let input: unknown;
  try {
    input = JSON.parse(body.toString("utf8"));
  } catch {
    throw new CloudError(
      400,
      "invalid_json",
      "Request body is not valid JSON.",
    );
  }
  return schema.parse(input);
}
