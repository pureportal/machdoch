import { notFound } from "next/navigation";
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
  await requirePageSession();
  const { instanceId } = await params;
  const { session } = await searchParams;
  const instance = getRuntime().fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null) notFound();
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
