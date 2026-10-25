import { redirect } from "next/navigation";
import { AiProviderSettings } from "@/components/cloud/provider-settings";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function ProvidersPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = await runtime.planning.workspace(actor);
  if (!["owner", "admin"].includes(workspace.actor.role))
    redirect("/cloud/issues");
  return (
    <AiProviderSettings
      settings={await runtime.aiProviders.list(actor, true)}
    />
  );
}
