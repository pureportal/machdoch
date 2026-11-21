import type { CloudAttachment } from "@/lib/cloud-attachment-contract";
import { cloudUpload } from "./api-client";
import { attachmentsChangedEvent } from "./events";

export async function uploadAttachment(
  file: File,
  issueId: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CloudAttachment> {
  const query = new URLSearchParams({
    name: file.name.trim().slice(0, 200) || "file",
    ...(issueId ? { issueId } : {}),
  });
  const attachment = await cloudUpload<CloudAttachment>(
    `attachments?${query}`,
    file,
    onProgress,
  );
  if (issueId) window.dispatchEvent(new Event(attachmentsChangedEvent));
  return attachment;
}
