import { notFound } from "next/navigation";
import { getRuntime } from "@/server/runtime";
import { SettingsManager } from "./settings-manager";

export const dynamic = "force-dynamic";

export default function SettingsPage(): React.ReactElement {
  if (!getRuntime().settingsCipher) notFound();
  return <SettingsManager />;
}
