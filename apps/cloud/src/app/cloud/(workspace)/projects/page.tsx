import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";
export default async function ProjectsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, progress, updates, initiatives] = await Promise.all([
    requireCloudWorkspace(),
    runtime.projects.progress(actor),
    runtime.projectUpdates.latest(actor),
    runtime.initiatives.list(actor),
  ]);
  return (
    <PlanningCatalog
      kind="projects"
      workspace={workspace}
      progress={progress}
      updates={updates}
      initiatives={initiatives}
    />
  );
}
