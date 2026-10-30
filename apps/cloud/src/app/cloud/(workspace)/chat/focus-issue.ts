import type { ChatFocusIssue } from "@/components/cloud/chat";
import type { CloudActor } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import type { CloudRuntime } from "@/server/cloud/runtime";

export async function readFocusIssue(
  runtime: CloudRuntime,
  actor: CloudActor,
  id: string,
): Promise<ChatFocusIssue | null> {
  try {
    const issue = await runtime.planning.getIssue(actor, id);
    return { id: issue.id, identifier: issue.identifier, title: issue.title };
  } catch (error) {
    if (isCloudError(error) && error.status === 404) return null;
    throw error;
  }
}
