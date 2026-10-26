import { CloudConnections } from "@/components/cloud/connections";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function Connections() {
  const { runtime, actor } = await requireCloudPageSession();
  return (
    <CloudConnections
      connections={await runtime.authorization.connections(actor)}
      origin={runtime.origin}
    />
  );
}
