import { getCloudRuntime } from "@/server/cloud/runtime";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";
import { InstancesView } from "./instances-view";

export const dynamic = "force-dynamic";

export default async function InstancesPage(): Promise<React.ReactElement> {
  const session = await requirePageSession();
  const members = session.manager
    ? (await (await getCloudRuntime()).planning.workspace(session)).members
    : [];
  return (
    <InstancesView
      cloudUrl={getRuntime().config.externalBaseUrl}
      manager={session.manager}
      members={members.map(({ id, name }) => ({ id, name }))}
    />
  );
}
