import { notFound } from "next/navigation";
import { getRuntime } from "@/server/runtime";
import { SettingsManager } from "./settings-manager";
import { requireManagerPage } from "@/server/page-auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage(): Promise<React.ReactElement> {
  await requireManagerPage();
  if (!getRuntime().settingsCipher) notFound();
  return (
    <SettingsManager
      initialDeliveryEnabled={await getRuntime().settingsStore.deliveryEnabled()}
    />
  );
}
