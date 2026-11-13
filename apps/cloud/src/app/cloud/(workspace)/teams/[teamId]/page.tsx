import { notFound } from "next/navigation";
import { TeamHome } from "@/components/cloud/team-home";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const id = cloudId.safeParse((await params).teamId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const team = workspace.teams.find((entry) => entry.id === id.data);
  if (!team) notFound();
  const cycle =
    workspace.cycles.find(
      (entry) => entry.teamId === team.id && entry.status === "active",
    ) ?? null;
  try {
    const [home, issues, progress, updates, burnup] = await Promise.all([
      runtime.teamHomes.get(actor, team.id),
      runtime.planning.listIssueSummaries(actor, { teamId: team.id }),
      runtime.projects.progress(actor),
      runtime.projectUpdates.latest(actor),
      cycle ? runtime.cycles.burnup(actor, cycle.id) : Promise.resolve([]),
    ]);
    return (
      <TeamHome
        team={team}
        home={home}
        issues={issues}
        progress={progress}
        updates={updates}
        cycle={cycle}
        burnup={burnup}
        workspace={workspace}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
