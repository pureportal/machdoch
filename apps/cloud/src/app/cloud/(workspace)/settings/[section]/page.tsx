import { notFound, redirect } from "next/navigation";
import { SettingsSectionContent } from "@/components/cloud/settings-section-content";
import {
  isSettingsSection,
  settingsHref,
  settingsSectionAccess,
  settingsSections,
} from "@/lib/settings-navigation";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function SettingsSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const access = settingsSectionAccess(workspace.actor, section);
  if (access === "hidden") redirect(settingsHref("preferences"));
  return (
    <>
      <header className="cloud-page-header">
        <h1>{settingsSections[section].label}</h1>
      </header>
      <SettingsSectionContent
        section={section}
        access={access}
        runtime={runtime}
        actor={actor}
        workspace={workspace}
        project={(await searchParams).project ?? null}
      />
    </>
  );
}
