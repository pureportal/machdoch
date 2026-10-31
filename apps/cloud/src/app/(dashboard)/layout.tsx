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
  const [workspace, unread, views] = await Promise.all([
    runtime.planning.workspace(actor),
    runtime.inbox.unread(actor),
    runtime.views.list(actor),
  ]);
  return (
    <CloudShell workspace={workspace} unread={unread} views={views}>
      {children}
    </CloudShell>
  );
}
