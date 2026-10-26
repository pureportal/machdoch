import { requireCloudPageSession } from "@/server/cloud/page-auth";

export default async function RemoteClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const { organization } = await runtime.planning.workspace(actor);
  return (
    <div
      className="cloud-remote-surface"
      data-cloud-accent={organization.accent}
    >
      {children}
    </div>
  );
}
