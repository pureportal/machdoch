import { Inbox } from "@/components/cloud/inbox";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function InboxPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return <Inbox initial={await runtime.inbox.list(actor)} />;
}
