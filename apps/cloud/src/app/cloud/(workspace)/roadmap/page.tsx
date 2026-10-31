import { ProjectRoadmap } from "@/components/cloud/project-roadmap";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function RoadmapPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const [progress, milestones] = await Promise.all([
    runtime.projects.progress(actor),
    runtime.milestones.list(actor),
  ]);
  return (
    <ProjectRoadmap
      workspace={workspace}
      progress={progress}
      milestones={milestones}
    />
  );
}
