import { Triage } from "@/components/cloud/triage";
import { cloudId } from "@/lib/cloud-contract";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function TriagePage({
  searchParams,
}: {
  searchParams: Promise<{ teamId?: string }>;
}) {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const teamId = cloudId.safeParse((await searchParams).teamId).data ?? null;
  return (
    <Triage
      key={teamId ?? "all"}
      initial={await runtime.triage.list(actor, teamId)}
      workspace={workspace}
      teamId={teamId}
    />
  );
}
