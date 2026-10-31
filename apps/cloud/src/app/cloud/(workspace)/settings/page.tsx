import { redirect } from "next/navigation";
import { CloudSettings } from "@/components/cloud/settings";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function SettingsPage() {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = (await requireCloudWorkspace()).workspace;
  if (!["owner", "admin"].includes(workspace.actor.role))
    redirect("/cloud/issues");
  return (
    <CloudSettings
      data={await runtime.administration.get(actor)}
      actor={workspace.actor}
    />
  );
}
