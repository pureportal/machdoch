import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";
export default async function ProjectsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <PlanningCatalog
      kind="projects"
      workspace={(await requireCloudWorkspace()).workspace}
      progress={await runtime.projects.progress(actor)}
    />
  );
}
