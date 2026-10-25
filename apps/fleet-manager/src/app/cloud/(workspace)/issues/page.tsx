import { cloudId } from "@/lib/cloud-contract";
import { IssueList } from "@/components/cloud/issue-list";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const params = await searchParams;
  const filters = {
    teamId: cloudId.safeParse(params.teamId).data,
    projectId: cloudId.safeParse(params.projectId).data,
    cycleId: cloudId.safeParse(params.cycleId).data,
    labelId: cloudId.safeParse(params.labelId).data,
    statusId: cloudId.safeParse(params.statusId).data,
    query:
      typeof params.query === "string" ? params.query.slice(0, 200) : undefined,
    archived: params.archived === "true",
    offset: Math.min(
      1_000_000,
      Math.max(0, Number.parseInt(String(params.offset ?? "0"), 10) || 0),
    ),
  };
  const workspace = await runtime.planning.workspace(actor);
  const issues = await runtime.planning.listIssues(actor, filters);
  const labels =
    filters.teamId && workspace.teams.some((team) => team.id === filters.teamId)
      ? await runtime.labels.list(actor, filters.teamId)
      : [];
  return <IssueList workspace={workspace} issues={issues} labels={labels} />;
}
