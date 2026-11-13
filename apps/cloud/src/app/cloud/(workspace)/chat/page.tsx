import { notFound } from "next/navigation";
import { AgentPage } from "@/components/cloud/agent/agent-page";
import { holderCan } from "@/lib/cloud-permissions";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function AgentIndexPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "ai.chat")) notFound();
  return (
    <AgentPage
      key="new"
      workspace={workspace}
      initialChats={await runtime.chat.store.list(actor)}
    />
  );
}
