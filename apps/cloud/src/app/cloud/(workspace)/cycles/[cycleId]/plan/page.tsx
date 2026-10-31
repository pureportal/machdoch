import { notFound } from "next/navigation";
import { CyclePlanner } from "@/components/cloud/cycle-planner";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

const openStates = ["backlog", "ready", "active", "blocked", "review"] as const;

export default async function CyclePlanPage({
  params,
}: {
  params: Promise<{ cycleId: string }>;
}) {
  const id = cloudId.safeParse((await params).cycleId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const cycle = workspace.cycles.find((entry) => entry.id === id.data);
  if (!cycle) notFound();
  try {
    const [scheduled, backlog] = await Promise.all([
      runtime.planning.listIssueSummaries(actor, {
        teamId: cycle.teamId,
        cycleId: cycle.id,
      }),
      runtime.planning.listIssueSummaries(actor, {
        teamId: cycle.teamId,
        noCycle: true,
        states: [...openStates],
      }),
    ]);
    return (
      <CyclePlanner
        cycle={cycle}
        workspace={workspace}
        scheduled={scheduled}
        backlog={backlog}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
