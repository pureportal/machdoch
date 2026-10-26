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
  const workspace = await runtime.planning.workspace(actor);
  return <CloudShell workspace={workspace}>{children}</CloudShell>;
}
