import { requireUsableInstancePage } from "@/server/page-auth";
import { RemoteSpeech } from "./remote-speech";
import { StandaloneOnly } from "../standalone-only";
import Link from "next/link";
import { ArrowLeft, Monitor } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SpeechPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}): Promise<React.ReactElement> {
  const { instanceId } = await params;
  const instance = await requireUsableInstancePage(instanceId);
  return (
    <>
      <StandaloneOnly>
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
      </StandaloneOnly>
      <RemoteSpeech instanceId={instance.instanceId} />
    </>
  );
}
