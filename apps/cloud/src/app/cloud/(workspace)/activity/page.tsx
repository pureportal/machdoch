import { holderCan } from "@/lib/cloud-permissions";
import {
  AiActivityView,
  type AiActivityScope,
} from "@/components/cloud/ai-activity-feed";
import { aiActivityQuerySchema } from "@/lib/cloud-activity-contract";
import { cloudId } from "@/lib/cloud-contract";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";
import { getRuntime } from "@/server/runtime";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = (await requireCloudWorkspace()).workspace;
  const admin = holderCan(workspace.actor, "clients.manage");
  const parameters = await searchParams;
  const runId = cloudId.safeParse(parameters.run);
  const clientId = aiActivityQuerySchema.shape.clientId.safeParse(
    parameters.client,
  );
  let scope: AiActivityScope | null = null;
  if (runId.success) {
    const run = await runtime.execution.runs.get(actor, runId.data);
    scope = { kind: "run", id: run.id, title: run.title };
  } else if (admin && clientId.success && clientId.data) {
    const instance = await getRuntime().fleetStore.getInstance(clientId.data);
    if (instance)
      scope = {
        kind: "client",
        id: instance.instanceId,
        title: instance.displayName,
      };
  }
  return (
    <AiActivityView
      initial={await runtime.activity.feed.list(
        actor,
        aiActivityQuerySchema.parse(
          scope?.kind === "run"
            ? { runId: scope.id }
            : scope
              ? { clientId: scope.id }
              : {},
        ),
      )}
      scope={scope}
      admin={admin}
    />
  );
}
