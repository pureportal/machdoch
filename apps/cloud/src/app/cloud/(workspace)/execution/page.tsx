import { redirect } from "next/navigation";
import { legacySettingsHref } from "@/lib/settings-navigation";

export default async function LegacyExecutionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacySettingsHref("execution", await searchParams));
}