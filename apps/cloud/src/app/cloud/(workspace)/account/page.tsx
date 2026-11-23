import { redirect } from "next/navigation";
import { legacySettingsHref } from "@/lib/settings-navigation";

export default async function LegacyAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacySettingsHref("account", await searchParams));
}