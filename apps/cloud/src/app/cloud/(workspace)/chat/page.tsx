import { AgentPage } from "@/components/cloud/agent/agent-page";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function AgentIndexPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  return (
    <AgentPage
      key="new"
      workspace={workspace}
      initialChats={await runtime.chat.store.list(actor)}
    />
  );
}
