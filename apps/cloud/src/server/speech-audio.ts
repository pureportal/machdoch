import { createRemoteSpeechRuntime } from "@machdoch/speech/remote";
import {
  speechRequestSchema,
  speechResponseSchema,
} from "@machdoch/fleet-protocol/speech";
import { z } from "zod";
import { requireOwner } from "./request-auth";
import {
  requireManagedInstance,
  relayInstanceRequest,
  throwHostError,
} from "./instance-relay";
import { HttpError } from "./errors";
import type { FleetRuntime } from "./runtime";
import { scopeSpeechRequest } from "./speech-identity";

export async function streamSpeechAudio(
  runtime: FleetRuntime,
  request: Request,
  instanceId: string,
  assetId: string,
): Promise<Response> {
  await requireOwner(runtime, request);
  await requireManagedInstance(runtime, instanceId);
  const url = new URL(request.url);
  const client = z.string().uuid().safeParse(url.searchParams.get("client"));
  const policy = z
    .enum(["cancel", "retain"])
    .safeParse(url.searchParams.get("disconnect"));
  if (
    !client.success ||
    !policy.success ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(assetId)
  )
    throw new HttpError(400, "Choose a valid speech session and audio asset.");
  const speech = createRemoteSpeechRuntime(
    async (operation) => {
      const session = await requireOwner(runtime, request);
      await requireManagedInstance(runtime, instanceId);
      const response = await relayInstanceRequest(
        runtime,
        instanceId,
        {
          type: "speech",
          request: scopeSpeechRequest(
            speechRequestSchema.parse(operation),
            session.sessionHash,
            instanceId,
          ),
        },
        request.signal,
      );
      await requireOwner(runtime, request);
      await requireManagedInstance(runtime, instanceId);
      if (response.type === "error") throwHostError(response);
      if (response.type !== "speech")
        throw new HttpError(
          502,
          "The device returned an invalid speech response.",
        );
      const parsed = speechResponseSchema.parse(response.response);
      if (parsed.state === "events")
        throw new HttpError(
          502,
          "The device returned an unexpected speech event.",
        );
      return parsed;
    },
    {
      clientId: client.data,
      disconnectPolicy: policy.data,
      onDiagnostic: (message) => console.error(message),
    },
  );
  const asset = await speech.downloadInfo(assetId);
  if (
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    asset.bytes > 8 * 1024 * 1024 * 1024 ||
    typeof asset.mimeType !== "string" ||
    /[\r\n]/u.test(asset.mimeType) ||
    !/^[\da-f]{64}$/u.test(asset.sha256)
  )
    throw new HttpError(
      502,
      "The device returned invalid speech asset metadata.",
    );
  const range = request.headers.get("range");
  let offset = 0;
  let end = asset.bytes - 1;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
    if (!match)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.bytes}` },
      });
    offset = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(end) ||
      offset > end ||
      end >= asset.bytes
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.bytes}` },
      });
  }
  const initial = offset;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        request.signal.throwIfAborted();
        if (offset > end) {
          controller.close();
          return;
        }
        const chunk = await speech.readAsset(
          assetId,
          offset,
          Math.min(65_536, end - offset + 1),
        );
        const bytes = Buffer.from(chunk.audioBase64, "base64");
        if (
          chunk.nextOffset !== offset + bytes.length ||
          !bytes.length ||
          chunk.nextOffset > end + 1 ||
          chunk.totalBytes !== asset.bytes
        )
          throw new Error("The speech asset stream is truncated or malformed.");
        offset = chunk.nextOffset;
        controller.enqueue(bytes);
        if (offset > end) controller.close();
      } catch {
        controller.error(
          new Error(
            "Speech audio streaming was interrupted. Reconnect the owning device.",
          ),
        );
      }
    },
  });
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(end - initial + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${asset.sha256}"`,
      ...(range
        ? { "Content-Range": `bytes ${initial}-${end}/${asset.bytes}` }
        : {}),
    },
  });
}
