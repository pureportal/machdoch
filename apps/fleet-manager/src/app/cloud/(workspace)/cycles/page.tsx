import { PlanningCatalog } from "@/components/cloud/planning-catalog";
import { requireCloudPageSession } from "@/server/cloud/page-auth";
export default async function CyclesPage() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <PlanningCatalog
      kind="cycles"
      workspace={await runtime.planning.workspace(actor)}
    />
  );
}
