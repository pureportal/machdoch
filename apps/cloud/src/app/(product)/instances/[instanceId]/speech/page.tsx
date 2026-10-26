import { notFound } from "next/navigation";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";
import { RemoteSpeech } from "./remote-speech";
import Link from "next/link";
import { ArrowLeft, Monitor } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SpeechPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<React.ReactElement> {
  await requirePageSession();
  const { instanceId } = await params;
  const instance = await getRuntime().fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) notFound();
  return (
    <>
      <nav className="cloud-remote-toolbar" aria-label="Client navigation">
        <Link href={`/instances/${instance.instanceId}`}>
          <ArrowLeft size={15} />
          <span>{instance.displayName}</span>
        </Link>
        <Link href="/instances">
          <Monitor size={15} />
          Clients
        </Link>
      </nav>
      <RemoteSpeech instanceId={instance.instanceId} />
    </>
  );
}
