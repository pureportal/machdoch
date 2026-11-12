import { z } from "zod";
import {
  cloudId,
  revision,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  channelInputSchema,
  channelUpdateSchema,
  postStateSchema,
  postUpdateSchema,
  productInputSchema,
  productUpdateSchema,
  releaseCaptureSchema,
  releaseInputSchema,
  releaseItemsSchema,
  releaseLaunchSchema,
  releaseUpdateSchema,
  releaseWriteSchema,
  socialAppInputSchema,
  socialNetworks,
} from "../../../lib/cloud-release-contract";
import {
  mediaUpdateSchema,
  mediaUploadQuerySchema,
  videoInputSchema,
  visualInputSchema,
} from "../../../lib/cloud-release-media-contract";
import { CloudError, isCloudError } from "../access";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import type { MediaFile } from "./release-media";

const archiveSchema = z.strictObject({ revision, archived: z.boolean() });
const networkSchema = z.enum(socialNetworks);
const captureQuerySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  caption: z.string().trim().max(300).default(""),
});

function fileResponse(file: MediaFile, cache: string): Response {
  const partial = file.start > 0 || file.end < file.total - 1;
  return new Response(file.body, {
    status: partial ? 206 : 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.end - file.start + 1),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${encodeURIComponent(file.name)}"`,
      "Cache-Control": cache,
      ...(partial
        ? { "Content-Range": `bytes ${file.start}-${file.end}/${file.total}` }
        : {}),
    },
  });
}

function redirect(location: string | URL, status = 303): Response {
  return new Response(null, {
    status,
    headers: { Location: String(location) },
  });
}

function uploadMime(request: Request): string {
  return (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function requireBody(request: Request): ReadableStream<Uint8Array> {
  if (!request.body)
    throw new CloudError(400, "media_empty", "The file is empty.");
  return request.body;
}

export async function handlePublicReleaseApi(
  runtime: CloudRuntime,
  request: Request,
  path: string[],
): Promise<Response> {
  const { media, studio } = runtime.releases;
  if (
    path[0] === "release-media" &&
    path[1] === "public" &&
    path.length === 3
  ) {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return fileResponse(
      await media.readShared(
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .parse(path[2]),
        request.headers.get("range"),
      ),
      "public, max-age=3600",
    );
  }
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const url = new URL(request.url);
  const query = captureQuerySchema.parse(Object.fromEntries(url.searchParams));
  return Response.json(
    await studio.receiveCapture(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(path[1]),
      { ...query, mime: uploadMime(request) },
      requireBody(request),
    ),
    { status: 201 },
  );
}

export function isPublicReleaseRoute(path: string[]): boolean {
  return (
    (path[0] === "release-media" &&
      path[1] === "public" &&
      path.length === 3) ||
    (path[0] === "release-capture" && path.length === 2)
  );
}

export const releaseRoutePrefixes = new Set([
  "products",
  "channels",
  "social",
  "releases",
  "release-posts",
  "release-media",
]);

async function socialCallback(
  runtime: CloudRuntime,
  actor: CloudActor,
  network: z.infer<typeof networkSchema>,
  url: URL,
): Promise<Response> {
  const target = new URL("/cloud/releases/connections", runtime.origin);
  try {
    const error = url.searchParams.get("error");
    if (error)
      throw new CloudError(
        400,
        "social_denied",
        url.searchParams.get("error_description") ??
          "The sign-in was canceled.",
      );
    await runtime.releases.social.completeConnect(
      actor,
      network,
      z.string().min(1).max(2_000).parse(url.searchParams.get("code")),
      z.string().min(1).max(200).parse(url.searchParams.get("state")),
    );
    target.searchParams.set("connected", network);
  } catch (error) {
    if (!isCloudError(error) && !(error instanceof z.ZodError)) throw error;
    target.searchParams.set(
      "error",
      isCloudError(error)
        ? error.message.slice(0, 200)
        : "The sign-in response was invalid.",
    );
  }
  return redirect(target, 303);
}

export async function handleReleaseApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/v1/".length).split("/").filter(Boolean);
  const method = request.method;
  const query = Object.fromEntries(url.searchParams);
  const { products, social, releases, media, studio } = runtime.releases;
  const key = () => cloudId.parse(request.headers.get("idempotency-key"));
  const id = (index: number) => cloudId.parse(path[index]);
  const route = `${method} ${path
    .map((segment) => (cloudId.safeParse(segment).success ? ":id" : segment))
    .join("/")}`;

  switch (route) {
    case "GET products":
      return Response.json(
        await products.list(actor, query.archived === "true"),
      );
    case "POST products":
      return Response.json(
        await products.create(
          actor,
          key(),
          await readBody(request, productInputSchema),
        ),
      );
    case "GET products/:id":
      return Response.json(await products.get(actor, id(1)));
    case "PATCH products/:id":
      return Response.json(
        await products.update(
          actor,
          key(),
          id(1),
          await readBody(request, productUpdateSchema),
        ),
      );
    case "POST products/:id/archive":
      await products.archive(
        actor,
        id(1),
        await readBody(request, archiveSchema),
      );
      return Response.json({ ok: true });
    case "POST products/:id/channels":
      return Response.json(
        await products.createChannel(
          actor,
          key(),
          id(1),
          await readBody(request, channelInputSchema),
        ),
      );
    case "PATCH channels/:id":
      return Response.json(
        await products.updateChannel(
          actor,
          key(),
          id(1),
          await readBody(request, channelUpdateSchema),
        ),
      );
    case "DELETE channels/:id":
      await products.removeChannel(actor, id(1));
      return Response.json({ ok: true });
    case "GET social/apps":
      return Response.json(await social.apps(actor));
    case "GET social/accounts":
      return Response.json(await social.accounts(actor));
    case "PUT social/apps/linkedin":
    case "PUT social/apps/reddit":
      await social.setApp(
        actor,
        networkSchema.parse(path[2]),
        await readBody(request, socialAppInputSchema),
      );
      return Response.json({ ok: true });
    case "DELETE social/accounts/:id":
      await social.removeAccount(actor, id(2));
      return Response.json({ ok: true });
    case "GET social/accounts/:id/targets":
      return Response.json(await social.targets(actor, id(2)));
    case "GET social/accounts/:id/flairs":
      return Response.json(
        await social.flairs(
          actor,
          id(2),
          z
            .string()
            .regex(/^[A-Za-z0-9_]{2,21}$/)
            .parse(query.subreddit),
        ),
      );
    case "GET social/linkedin/connect":
    case "GET social/reddit/connect":
      return redirect(
        await social.startConnect(actor, networkSchema.parse(path[1])),
        303,
      );
    case "GET social/linkedin/callback":
    case "GET social/reddit/callback":
      return socialCallback(runtime, actor, networkSchema.parse(path[1]), url);
    case "GET releases":
      return Response.json(
        await releases.list(actor, {
          productId: query.productId
            ? cloudId.parse(query.productId)
            : undefined,
          archived: query.archived === "true",
        }),
      );
    case "POST releases":
      return Response.json(
        await releases.create(
          actor,
          key(),
          await readBody(request, releaseInputSchema),
        ),
      );
    case "GET releases/:id":
      return Response.json(await releases.get(actor, id(1)));
    case "PATCH releases/:id":
      return Response.json(
        await releases.update(
          actor,
          key(),
          id(1),
          await readBody(request, releaseUpdateSchema),
        ),
      );
    case "POST releases/:id/items":
      await releases.setItems(
        actor,
        id(1),
        await readBody(request, releaseItemsSchema),
      );
      return Response.json({ ok: true });
    case "POST releases/:id/refresh":
      await releases.refreshItems(actor, id(1));
      return Response.json({ ok: true });
    case "POST releases/:id/archive":
      await releases.archive(
        actor,
        id(1),
        await readBody(request, archiveSchema),
      );
      return Response.json({ ok: true });
    case "POST releases/:id/launch":
      return Response.json(
        await releases.launch(
          actor,
          key(),
          id(1),
          await readBody(request, releaseLaunchSchema),
        ),
      );
    case "POST releases/:id/write":
      return Response.json(
        await studio.startWrite(
          actor,
          key(),
          id(1),
          await readBody(request, releaseWriteSchema),
        ),
      );
    case "POST releases/:id/visuals":
      return Response.json(
        await studio.createVisual(
          actor,
          id(1),
          await readBody(request, visualInputSchema),
        ),
      );
    case "POST releases/:id/visuals/preview":
      return new Response(
        new Uint8Array(
          await studio.previewVisual(
            actor,
            id(1),
            await readBody(request, visualInputSchema),
          ),
        ),
        { headers: { "Content-Type": "image/png" } },
      );
    case "POST releases/:id/videos":
      return Response.json(
        await studio.queueVideo(
          actor,
          key(),
          id(1),
          await readBody(request, videoInputSchema),
        ),
      );
    case "POST releases/:id/capture":
      return Response.json(
        await studio.startCapture(
          actor,
          id(1),
          await readBody(request, releaseCaptureSchema),
        ),
      );
    case "PATCH release-posts/:id":
      return Response.json(
        await releases.updatePost(
          actor,
          key(),
          id(1),
          await readBody(request, postUpdateSchema),
        ),
      );
    case "POST release-posts/:id/state":
      return Response.json(
        await releases.changePost(
          actor,
          key(),
          id(1),
          await readBody(request, postStateSchema),
        ),
      );
    case "GET release-media":
      return Response.json(
        await media.list(actor, {
          productId: cloudId.parse(query.productId),
          releaseId: query.releaseId ? cloudId.parse(query.releaseId) : null,
        }),
      );
    case "POST release-media": {
      const upload = mediaUploadQuerySchema.parse(query);
      return Response.json(
        await media.upload(
          actor,
          { productId: upload.productId, releaseId: upload.releaseId ?? null },
          {
            name: upload.name,
            role: upload.role,
            caption: upload.caption,
            mime: uploadMime(request),
          },
          requireBody(request),
        ),
        { status: 201 },
      );
    }
    case "GET release-media/capabilities":
      return Response.json(await studio.capabilities());
    case "GET release-media/:id":
      return fileResponse(
        await media.read(actor, id(1), request.headers.get("range")),
        "private, max-age=300",
      );
    case "PATCH release-media/:id":
      return Response.json(
        await media.update(
          actor,
          id(1),
          await readBody(request, mediaUpdateSchema),
        ),
      );
    case "DELETE release-media/:id":
      await media.remove(actor, id(1));
      return Response.json({ ok: true });
  }
  throw new CloudError(404, "not_found", "Release action is unavailable.");
}
