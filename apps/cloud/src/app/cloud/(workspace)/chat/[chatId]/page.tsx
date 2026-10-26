import { notFound } from "next/navigation";
import { CloudChatView } from "@/components/cloud/chat";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const id = cloudId.safeParse((await params).chatId);
  if (!id.success) notFound();
  const { runtime, actor } = await requireCloudPageSession();
  try {
    return (
      <CloudChatView
        key={id.data}
        workspace={await runtime.planning.workspace(actor)}
        settings={await runtime.aiProviders.list(actor)}
        initialChats={await runtime.chat.store.list(actor)}
        initial={await runtime.chat.store.get(actor, id.data)}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
