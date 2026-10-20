import { notFound } from "next/navigation";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";
import { RemoteSpeech } from "./remote-speech";

export const dynamic = "force-dynamic";

export default async function SpeechPage({ params }: { params: Promise<{ instanceId: string }> }): Promise<React.ReactElement> {
  await requirePageSession();
  const { instanceId } = await params;
  const instance = getRuntime().fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) notFound();
  return <RemoteSpeech instanceId={instance.instanceId} />;
}
