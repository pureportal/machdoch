import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
export default async function TeamsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <PlanningCatalog
      kind="teams"
      workspace={await runtime.planning.workspace(actor)}
    />
  );
}
