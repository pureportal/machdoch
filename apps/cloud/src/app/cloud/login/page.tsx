import { CloudAuthForm } from "@/components/cloud/auth-form";
import { redirect } from "next/navigation";
import { getCloudRuntime } from "@/server/cloud/runtime";
import { cloudId } from "@/lib/cloud-contract";
export const dynamic = "force-dynamic";
export default async function CloudLogin({
  searchParams,
}: {
  searchParams: Promise<{ authorize?: string }>;
}) {
  const runtime = await getCloudRuntime();
  const initialized = await runtime.database.transaction(async (sql) =>
    Boolean(
      (await sql.query("SELECT id FROM cloud_organizations LIMIT 1")).rows
        .length,
    ),
  );
  if (!initialized) redirect("/cloud/setup");
  const authorization = cloudId.safeParse((await searchParams).authorize);
  return (
    <CloudAuthForm
      authorizationId={authorization.success ? authorization.data : undefined}
    />
  );
}
