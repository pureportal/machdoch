import { InitiativeList } from "@/components/cloud/initiative-list";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function InitiativesPage() {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  return (
    <InitiativeList
      initiatives={await runtime.initiatives.list(actor)}
      workspace={workspace}
    />
  );
}
