import { CloudChatView } from "@/components/cloud/chat";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function ChatPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <CloudChatView
      key="new"
      workspace={await runtime.planning.workspace(actor)}
      settings={await runtime.aiProviders.list(actor)}
      initialChats={await runtime.chat.store.list(actor)}
    />
  );
}
