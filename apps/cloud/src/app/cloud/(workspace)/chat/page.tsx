import { CloudChatView } from "@/components/cloud/chat";
import { cloudId } from "@/lib/cloud-contract";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
import { readFocusIssue } from "./focus-issue";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string }>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const issueId = cloudId.safeParse((await searchParams).issue);
  return (
    <CloudChatView
      key={issueId.success ? `new-${issueId.data}` : "new"}
      workspace={await runtime.planning.workspace(actor)}
      settings={await runtime.aiProviders.list(actor)}
      initialChats={await runtime.chat.store.list(actor)}
      focusIssue={
        issueId.success
          ? await readFocusIssue(runtime, actor, issueId.data)
          : null
      }
    />
  );
}
