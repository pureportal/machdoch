import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { cloudSessionCookie } from "./identity";
import { getCloudRuntime } from "./runtime";

export const requireCloudPageSession = cache(async () => {
  const runtime = await getCloudRuntime();
  const token = (await cookies()).get(cloudSessionCookie)?.value ?? "";
  const actor = await runtime.identity.authenticate(token);
  if (!actor) redirect("/cloud/login");
  return { runtime, actor };
});

export const requireCloudWorkspace = cache(async () => {
  const session = await requireCloudPageSession();
  const workspace = await session.runtime.planning.workspace(session.actor);
  return { ...session, workspace };
});
