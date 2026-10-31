import { CloudShell } from "@/components/cloud/cloud-shell";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const [unread, views] = await Promise.all([
    runtime.inbox.unread(actor),
    runtime.views.list(actor),
  ]);
  return (
    <CloudShell workspace={workspace} unread={unread} views={views}>
      {children}
    </CloudShell>
  );
}
