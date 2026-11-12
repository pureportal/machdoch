import { CloudShell } from "@/components/cloud/cloud-shell";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { runtime, actor, workspace } = await requireCloudWorkspace();
  const [unread, views, favorites, triage, sidebar] = await Promise.all([
    runtime.inbox.unread(actor),
    runtime.views.list(actor),
    runtime.favorites.list(actor),
    runtime.triage.counts(actor),
    runtime.sidebar.get(actor),
  ]);
  return (
    <CloudShell
      workspace={workspace}
      unread={unread}
      views={views}
      favorites={favorites}
      triage={triage}
      sidebar={sidebar}
    >
      {children}
    </CloudShell>
  );
}
