import { CloudChatView } from "@/components/cloud/chat";
import { cloudId } from "@/lib/cloud-contract";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";
import { readFocusIssue } from "./focus-issue";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string; prompt?: string }>;
}) {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const parameters = await searchParams;
  const issueId = cloudId.safeParse(parameters.issue);
  const [settings, initialChats, focusIssue] = await Promise.all([
    runtime.aiProviders.list(actor),
    runtime.chat.store.list(actor),
    issueId.success ? readFocusIssue(runtime, actor, issueId.data) : null,
  ]);
  return (
    <CloudChatView
      key={issueId.success ? `new-${issueId.data}` : "new"}
      workspace={workspace}
      settings={settings}
      initialChats={initialChats}
      focusIssue={focusIssue}
      initialPrompt={parameters.prompt?.slice(0, 2000) ?? ""}
    />
  );
}
