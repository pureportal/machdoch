import { redirect } from "next/navigation";
import { legacySettingsHref, settingsHref } from "@/lib/settings-navigation";
import { setupChecklist } from "@/lib/setup-checklist";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function LegacySettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (Object.keys(params).length)
    redirect(legacySettingsHref("settings", params));
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const steps = setupChecklist(
    workspace.actor,
    await runtime.setup.facts(actor),
  );
  redirect(
    settingsHref(steps.some((step) => !step.done) ? "setup" : "preferences"),
  );
}
