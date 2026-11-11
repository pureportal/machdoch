import { PulseFeed } from "@/components/cloud/pulse-feed";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function PulsePage() {
  const { runtime, actor } = await requireCloudPageSession();
  return <PulseFeed updates={await runtime.projectUpdates.feed(actor)} />;
}
