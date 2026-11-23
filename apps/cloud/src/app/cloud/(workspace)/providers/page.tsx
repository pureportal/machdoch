import { redirect } from "next/navigation";
import { legacySettingsHref } from "@/lib/settings-navigation";

export default async function LegacyProvidersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacySettingsHref("providers", await searchParams));
}