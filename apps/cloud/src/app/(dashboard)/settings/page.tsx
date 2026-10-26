import { notFound } from "next/navigation";
import { getRuntime } from "@/server/runtime";
import { SettingsManager } from "./settings-manager";
import { requirePageSession } from "@/server/page-auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage(): Promise<React.ReactElement> {
  await requirePageSession();
  if (!getRuntime().settingsCipher) notFound();
  return (
    <SettingsManager
      initialDeliveryEnabled={await getRuntime().settingsStore.deliveryEnabled()}
    />
  );
}
