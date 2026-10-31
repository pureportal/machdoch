import { redirect } from "next/navigation";
import { ExecutionSettings } from "@/components/cloud/execution-settings";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function ExecutionPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = (await requireCloudWorkspace()).workspace;
  if (!["owner", "admin"].includes(workspace.actor.role))
    redirect("/cloud/tasks");
  return (
    <ExecutionSettings
      workspace={workspace}
      profiles={await runtime.execution.profiles.list(actor)}
      providers={(await runtime.aiProviders.list(actor, true)).providers}
    />
  );
}
