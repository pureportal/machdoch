import { LoopList } from "@/components/cloud/loop-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function LoopsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, loops] = await Promise.all([
    requireCloudWorkspace(),
    runtime.automations.loops.list(actor),
  ]);
  return <LoopList workspace={workspace} initial={loops} />;
}
