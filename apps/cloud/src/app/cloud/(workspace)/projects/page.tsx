import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
export default async function ProjectsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <PlanningCatalog
      kind="projects"
      workspace={await runtime.planning.workspace(actor)}
      progress={await runtime.projects.progress(actor)}
    />
  );
}
