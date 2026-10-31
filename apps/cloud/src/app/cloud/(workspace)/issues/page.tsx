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
  const [issues, labels] = await Promise.all([
    runtime.planning.listIssueSummaries(actor, filters),
    filters.teamId &&
    workspace.teams.some((team) => team.id === filters.teamId)
      ? runtime.labels.list(actor, filters.teamId)
      : [],
  ]);
  return <IssueList workspace={workspace} issues={issues} labels={labels} />;
}
