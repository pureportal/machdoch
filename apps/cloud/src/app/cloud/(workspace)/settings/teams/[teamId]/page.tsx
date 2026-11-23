import { redirect } from "next/navigation";
import { teamSettingsHref } from "@/lib/settings-navigation";

export default async function TeamSettingsIndex({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  redirect(teamSettingsHref((await params).teamId, "workflow"));
}
