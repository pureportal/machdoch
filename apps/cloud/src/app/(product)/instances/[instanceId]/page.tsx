import { notFound, redirect } from "next/navigation";
import { canUseClient } from "@/lib/client-access";
import { InstanceProduct } from "./instance-product";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function InstanceProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}): Promise<React.ReactElement> {
  const viewer = await requirePageSession();
  const { instanceId } = await params;
  const { session } = await searchParams;
  const instance = await getRuntime().fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) notFound();
  if (!canUseClient(viewer, instance)) redirect("/instances");
  return (
    <InstanceProduct
      instanceId={instance.instanceId}
      instanceName={instance.displayName}
      {...(typeof session === "string" &&
      session.length > 0 &&
      session.length <= 240
        ? { initialSessionId: session }
        : {})}
    />
  );
}
