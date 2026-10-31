import { notFound } from "next/navigation";
import { CloudChatView } from "@/components/cloud/chat";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";
import { readFocusIssue } from "../focus-issue";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const id = cloudId.safeParse((await params).chatId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  let initial;
  try {
    initial = await runtime.chat.store.get(actor, id.data);
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
  return (
    <CloudChatView
      key={id.data}
      workspace={(await requireCloudWorkspace()).workspace}
      settings={await runtime.aiProviders.list(actor)}
      initialChats={await runtime.chat.store.list(actor)}
      initial={initial}
      focusIssue={
        initial.chat.issueId
          ? await readFocusIssue(runtime, actor, initial.chat.issueId)
          : null
      }
    />
  );
}
