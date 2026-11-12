import { redirect } from "next/navigation";
import { CloudSettings } from "@/components/cloud/settings";
import { settingsTabs } from "@/lib/cloud-administration-contract";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = (await requireCloudWorkspace()).workspace;
  if (!["owner", "admin"].includes(workspace.actor.role))
    redirect("/cloud/issues");
  const requested = (await searchParams).tab;
  return (
    <CloudSettings
      data={await runtime.administration.get(actor)}
      actor={workspace.actor}
      tab={settingsTabs.find((entry) => entry === requested) ?? "organization"}
    />
  );
}
