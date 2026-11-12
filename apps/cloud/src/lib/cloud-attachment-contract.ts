export const attachmentImageTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const attachmentVideoTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;
export const attachmentTextTypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;
export const attachmentFileTypes = ["application/pdf", "application/zip"];
export const maximumAttachmentBytes = 50 * 1024 * 1024;
export const maximumChatAttachments = 6;
export const maximumModelImages = 6;
export const maximumModelImageBytes = 5 * 1024 * 1024;
export const attachmentSources = ["upload", "agent", "client"] as const;

export type AttachmentKind = "image" | "video" | "document" | "file";
export type AttachmentSource = (typeof attachmentSources)[number];

export interface CloudAttachment {
  id: string;
  issueId: string | null;
  name: string;
  mime: string;
  kind: AttachmentKind;
  byteLength: number;
  width: number | null;
  height: number | null;
  source: AttachmentSource;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  url: string;
}

const extensionTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function attachmentUrl(id: string): string {
  return `/api/v1/attachments/${id}`;
}

export function attachmentKind(mime: string): AttachmentKind | null {
  if ((attachmentImageTypes as readonly string[]).includes(mime))
    return "image";
  if ((attachmentVideoTypes as readonly string[]).includes(mime))
    return "video";
  if ((attachmentTextTypes as readonly string[]).includes(mime))
    return "document";
  if (attachmentFileTypes.includes(mime)) return "file";
  return null;
}

export function attachmentMime(name: string, reportedType: string): string {
  const type = reportedType.split(";", 1)[0]!.trim().toLowerCase();
  if (attachmentKind(type)) return type;
  return extensionTypes[name.split(".").pop()?.toLowerCase() ?? ""] ?? type;
}

export function attachmentMarkdown(attachment: {
  id: string;
  name: string;
  kind: AttachmentKind;
}): string {
  const label = attachment.name.replace(/[[\]\\]/g, "");
  return attachment.kind === "image"
    ? `![${label}](${attachmentUrl(attachment.id)})`
    : `[${label}](${attachmentUrl(attachment.id)})`;
}

export function referencedAttachmentIds(markdown: string): string[] {
  return [
    ...new Set(
      [
        ...markdown.matchAll(
          /\/api\/v1\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
        ),
      ].map((match) => match[1]!.toLowerCase()),
    ),
  ];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
