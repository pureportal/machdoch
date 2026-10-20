import { createHash } from "node:crypto";
import type { SpeechRequest } from "@machdoch/fleet-protocol/speech";

export function scopeSpeechRequest(
  request: SpeechRequest,
  sessionHash: string,
  instanceId: string,
): SpeechRequest {
  const scope = (value: string): string => {
    const hash = createHash("sha256")
      .update(JSON.stringify([sessionHash, instanceId, value]))
      .digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  const scoped = structuredClone(request);
  scoped.id = scope(request.id);
  if (scoped.kind === "invoke") {
    scoped.args.clientId = scope(scoped.args.clientId);
    if (Object.hasOwn(scoped.args.request.input, "owner"))
      scoped.args.request.input.owner = `remote:${scoped.args.clientId}`;
  }
  return scoped;
}
