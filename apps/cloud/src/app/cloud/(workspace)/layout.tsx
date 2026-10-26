import { CloudShell } from "@/components/cloud/cloud-shell";
import { requireCloudPageSession } from "@/server/cloud/page-auth";

export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { runtime, actor } = await requireCloudPageSession();
  const workspace = await runtime.planning.workspace(actor);
  return <CloudShell workspace={workspace}>{children}</CloudShell>;
}
