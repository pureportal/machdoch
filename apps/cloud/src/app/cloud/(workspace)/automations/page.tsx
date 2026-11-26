import { redirect } from "next/navigation";
import { LoopList } from "@/components/cloud/loop-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ automation?: string }>;
}) {
  const { automation } = await searchParams;
  if (automation) redirect(`/cloud/automations/${automation}`);
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, loops] = await Promise.all([
    requireCloudWorkspace(),
    runtime.automations.loops.list(actor),
  ]);
  return <LoopList workspace={workspace} initial={loops} />;
}
