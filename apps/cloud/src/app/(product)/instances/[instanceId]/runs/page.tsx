import { requireUsableInstancePage } from "@/server/page-auth";
import { RunsView } from "./runs-view";

export const dynamic = "force-dynamic";
export default async function RunsPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<React.ReactElement> {
  const { instanceId } = await params;
  const instance = await requireUsableInstancePage(instanceId);
  return (
    <RunsView instanceId={instanceId} instanceName={instance.displayName} />
  );
}
