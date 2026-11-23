import { redirect } from "next/navigation";
import { legacySettingsHref } from "@/lib/settings-navigation";

export default async function LegacySettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacySettingsHref("settings", await searchParams));
}