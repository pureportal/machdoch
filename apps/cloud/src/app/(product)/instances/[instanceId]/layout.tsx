import { BrandStyle } from "@/components/cloud/brand-theme";
import { requireCloudWorkspace } from "@/server/cloud/page-auth";

export default async function RemoteClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { organization } = (await requireCloudWorkspace()).workspace;
  return (
    <div className="cloud-remote-surface" data-cloud-brand="">
      <BrandStyle
        identity={organization}
        scope=".cloud-remote-surface[data-cloud-brand]"
      />
      {children}
    </div>
  );
}
