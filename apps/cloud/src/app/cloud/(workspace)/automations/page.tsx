import { AutomationList } from "@/components/cloud/automation-list";
import {
  requireCloudPageSession,
  requireCloudWorkspace,
} from "@/server/cloud/page-auth";

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ automation?: string }>;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const [{ workspace }, automations, { automation }] = await Promise.all([
    requireCloudWorkspace(),
    runtime.automations.service.list(actor),
    searchParams,
  ]);
  return (
    <AutomationList
      workspace={workspace}
      initial={automations}
      initialSelectedId={automation ?? null}
    />
  );
}
