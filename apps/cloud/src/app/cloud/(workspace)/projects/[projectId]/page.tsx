import { notFound } from "next/navigation";
import { ProjectDetail } from "@/components/cloud/project-detail";
import { cloudId } from "@/lib/cloud-contract";
import { isCloudError } from "@/server/cloud/access";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const id = cloudId.safeParse((await params).projectId);
  if (!id.success) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  try {
    const [project, progress, issues, milestones, runs, clients] =
      await Promise.all([
        runtime.projects.get(actor, id.data),
        runtime.projects.progress(actor),
        runtime.planning.listIssueSummaries(actor, { projectId: id.data }),
        runtime.milestones.list(actor, id.data),
        runtime.execution.runs.listForProject(actor, id.data),
        runtime.execution.workers.listForProject(actor, id.data),
      ]);
    return (
      <ProjectDetail
        project={project}
        progress={progress.find((entry) => entry.projectId === id.data)}
        issues={issues}
        milestones={milestones}
        runs={runs}
        clients={clients}
        workspace={workspace}
      />
    );
  } catch (error) {
    if (isCloudError(error) && error.status === 404) notFound();
    throw error;
  }
}
