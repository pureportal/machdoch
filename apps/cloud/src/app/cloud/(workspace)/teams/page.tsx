import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";
export default async function TeamsPage() {
  return (
    <PlanningCatalog
      kind="teams"
      workspace={(await requireCloudWorkspace()).workspace}
    />
  );
}
