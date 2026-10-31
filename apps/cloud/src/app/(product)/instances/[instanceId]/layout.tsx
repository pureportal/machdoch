import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function RemoteClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { organization } = (await requireCloudWorkspace()).workspace;
  return (
    <div
      className="cloud-remote-surface"
      data-cloud-accent={organization.accent}
    >
      {children}
    </div>
  );
}
