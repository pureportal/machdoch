import { redirect } from "next/navigation";
import { CloudSetupForm } from "@/components/cloud/setup-form";
import { getCloudRuntime } from "@/server/cloud/runtime";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const runtime = await getCloudRuntime();
  const initialized = await runtime.database.transaction(async (sql) =>
    Boolean(
      (await sql.query("SELECT id FROM cloud_organizations LIMIT 1")).rows
        .length,
    ),
  );
  if (initialized) redirect("/cloud/login");
  return <CloudSetupForm />;
}
