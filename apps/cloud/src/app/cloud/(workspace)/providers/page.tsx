import { holderCan } from "@/lib/cloud-permissions";
import { redirect } from "next/navigation";
import { AiProviderSettings } from "@/components/cloud/provider-settings";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ProvidersPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = (await requireCloudWorkspace()).workspace;
  if (!holderCan(workspace.actor, "ai.manage")) redirect("/cloud/issues");
  return (
    <AiProviderSettings
      settings={await runtime.aiProviders.list(actor, true)}
    />
  );
}
