import { holderCan } from "@/lib/cloud-permissions";
import { issueFiltersFromParameters } from "@/lib/issue-scopes";
import { IssueList } from "@/components/cloud/issue-list";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const filters = issueFiltersFromParameters(await searchParams);
  const teamId =
    filters.teamId && workspace.teams.some((team) => team.id === filters.teamId)
      ? filters.teamId
      : null;
  const [issues, labels, views, pinned, initiatives, milestones, pipelines] =
    await Promise.all([
      runtime.planning.listIssueSummaries(actor, filters),
      teamId
        ? runtime.labels.list(actor, teamId)
        : runtime.labels.listVisible(actor),
      runtime.views.list(actor),
      teamId ? runtime.views.pinned(actor, teamId) : null,
      runtime.initiatives.list(actor),
      runtime.milestones.list(actor),
      holderCan(workspace.actor, "releases.view")
        ? runtime.releases.pipelines.list(actor, { query: "", archived: false })
        : [],
    ]);
  return (
    <IssueList
      workspace={workspace}
      issues={issues}
      labels={labels}
      views={views}
      pinned={pinned}
      references={{ initiatives, milestones, pipelines }}
    />
  );
}
