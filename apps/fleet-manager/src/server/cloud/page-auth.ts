import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cloudSessionCookie } from "./identity";
import { getCloudRuntime } from "./runtime";

export async function requireCloudPageSession() {
  const runtime = await getCloudRuntime();
  const token = (await cookies()).get(cloudSessionCookie)?.value ?? "";
  const actor = await runtime.identity.authenticate(token);
  if (!actor) redirect("/cloud/login");
  return { runtime, actor };
}
