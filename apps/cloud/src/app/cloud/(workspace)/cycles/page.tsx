import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";
export default async function CyclesPage() {
  return (
    <PlanningCatalog
      kind="cycles"
      workspace={(await requireCloudWorkspace()).workspace}
    />
  );
}
