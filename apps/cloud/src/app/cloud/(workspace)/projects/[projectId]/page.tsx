import { notFound } from "next/navigation";
import { ProjectDetail } from "@/components/cloud/project-detail";
import { cloudId } from "@/lib/cloud-contract";
import { parseIssueFilterConditions } from "@/lib/issue-filter-model";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = cloudId.safeParse((await params).projectId);
  if (!id.success) notFound();
  const conditions = parseIssueFilterConditions(await searchParams).filter(
    (condition) => condition.field !== "project",
  );
  const projectCondition = {
    field: "project" as const,
    negated: false,
    values: [id.data],
  };
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  try {
    const [
      project,
      progress,
      projectIssues,
      filteredIssues,
      milestones,
      runs,
      clients,
      updates,
      favorites,
      labels,
    ] = await Promise.all([
      runtime.projects.get(actor, id.data),
      runtime.projects.progress(actor),
      runtime.planning.listIssueSummaries(actor, {
        conditions: [projectCondition],
      }),
      conditions.length
        ? runtime.planning.listIssueSummaries(actor, {
            conditions: [projectCondition, ...conditions],
          })
        : null,
      runtime.milestones.list(actor, id.data),
      runtime.execution.runs.listForProject(actor, id.data),
      runtime.execution.workers.listForProject(actor, id.data),
      runtime.projectUpdates.list(actor, id.data),
      runtime.favorites.list(actor),
      runtime.labels.listVisible(actor),
    ]);
    return (
      <ProjectDetail
        project={project}
        progress={progress.find((entry) => entry.projectId === id.data)}
        issues={filteredIssues ?? projectIssues}
        projectIssues={projectIssues}
        labels={labels.filter((label) => label.teamId === project.teamId)}
        milestones={milestones}
        runs={runs}
        clients={clients}
        updates={updates}
        favorite={favorites.some(
          (entry) => entry.kind === "project" && entry.id === id.data,
        )}
        workspace={workspace}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
