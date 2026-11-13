import { notFound } from "next/navigation";
import { AgentPage } from "@/components/cloud/agent/agent-page";
import { cloudId } from "@/lib/cloud-contract";
import { holderCan } from "@/lib/cloud-permissions";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function AgentConversationPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const id = cloudId.safeParse((await params).chatId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  if (!holderCan(workspace.actor, "ai.chat")) notFound();
  let initial;
  try {
    initial = await runtime.chat.store.get(actor, id.data);
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
  return (
    <AgentPage
      key={id.data}
      workspace={workspace}
      initialChats={await runtime.chat.store.list(actor)}
      initial={initial}
    />
  );
}
