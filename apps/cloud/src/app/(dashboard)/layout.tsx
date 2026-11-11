import { CloudShell } from "@/components/cloud/cloud-shell";
import { requirePageSession } from "@/server/page-auth";
import { getCloudRuntime } from "@/server/cloud/runtime";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await requirePageSession();
  const runtime = await getCloudRuntime();
  const [workspace, unread, views, favorites, triage] = await Promise.all([
    runtime.planning.workspace(actor),
    runtime.inbox.unread(actor),
    runtime.views.list(actor),
    runtime.favorites.list(actor),
    runtime.triage.counts(actor),
  ]);
  return (
    <CloudShell
      workspace={workspace}
      unread={unread}
      views={views}
      favorites={favorites}
      triage={triage}
    >
      {children}
    </CloudShell>
  );
}
