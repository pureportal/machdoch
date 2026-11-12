import { z } from "zod";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import { attachmentMime } from "../../../lib/cloud-attachment-contract";
import { CloudError } from "../access";
import type { StoredFile } from "../chunked-files";
import type { CloudRuntime } from "../runtime";

const uploadQuerySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  issueId: cloudId.optional(),
});
const uploadToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const inlineTypes = /^(image\/|video\/|application\/pdf$)/;

function attachmentResponse(file: StoredFile): Response {
  const partial = file.start > 0 || file.end < file.total - 1;
  return new Response(file.body, {
    status: partial ? 206 : 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.end - file.start + 1),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${inlineTypes.test(file.mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        file.mime === "application/pdf"
          ? "default-src 'none'; object-src 'self'"
          : "sandbox; default-src 'none'",
      ...(partial
        ? { "Content-Range": `bytes ${file.start}-${file.end}/${file.total}` }
        : {}),
    },
  });
}

function uploadBody(request: Request): ReadableStream<Uint8Array> {
  if (!request.body)
    throw new CloudError(400, "attachment_empty", "The file is empty.");
  return request.body;
}

function uploadType(request: Request, name: string): string {
  return attachmentMime(name, request.headers.get("content-type") ?? "");
}

export function isAttachmentRoute(path: string[]): boolean {
  return (
    path[0] === "attachments" ||
    (path[0] === "issues" &&
      path.length === 3 &&
      (path[2] === "attachments" || path[2] === "attachment-links"))
  );
}

export function isPublicAttachmentRoute(path: string[]): boolean {
  return path[0] === "attachment-uploads" && path.length === 2;
}

export async function handlePublicAttachmentApi(
  runtime: CloudRuntime,
  request: Request,
  path: string[],
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { name } = z
    .strictObject({ name: z.string().trim().min(1).max(200) })
    .parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(
    await runtime.attachments.receiveUpload(
      uploadToken.parse(path[1]),
      { name, mime: uploadType(request, name) },
      uploadBody(request),
    ),
    { status: 201 },
  );
}

export async function handleAttachmentApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  path: string[],
): Promise<Response> {
  const { attachments } = runtime;
  const method = request.method;
  if (path[0] === "issues") {
    const issueId = cloudId.parse(path[1]);
    if (method === "GET" && path[2] === "attachments")
      return Response.json({
        attachments: await attachments.list(actor, issueId),
      });
    if (method === "POST" && path[2] === "attachment-links") {
      const link = await attachments.createUploadLink(actor, issueId);
      return Response.json(
        {
          url: `${runtime.origin}/api/v1/attachment-uploads/${link.token}`,
          expiresAt: link.expiresAt,
        },
        { status: 201 },
      );
    }
  }
  if (path[0] === "attachments" && path.length === 1 && method === "POST") {
    const query = uploadQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      await attachments.upload(
        actor,
        query.issueId ?? null,
        { name: query.name, mime: uploadType(request, query.name) },
        uploadBody(request),
      ),
      { status: 201 },
    );
  }
  if (path[0] === "attachments" && path.length === 2) {
    const id = cloudId.parse(path[1]);
    if (method === "GET")
      return attachmentResponse(
        await attachments.read(actor, id, request.headers.get("range")),
      );
    if (method === "DELETE") {
      await attachments.remove(actor, id);
      return Response.json({ ok: true });
    }
  }
  throw new CloudError(404, "not_found", "Attachment action is unavailable.");
}
