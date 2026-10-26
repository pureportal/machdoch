import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CloudAuthorizationForm } from "@/components/cloud/authorization";
import { cloudId } from "@/lib/cloud-contract";
import { cloudSessionCookie } from "@/server/cloud/identity";
import { isCloudError } from "@/server/cloud/access";
import { getCloudRuntime } from "@/server/cloud/runtime";
import { AuthFrame } from "@/components/cloud/auth-frame";

export default async function Authorize({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string }>;
}) {
  const id = cloudId.safeParse((await searchParams).requestId);
  if (!id.success)
    return (
      <AuthFrame>
        <h1>Connect app</h1>
        <p role="alert">
          This connection request is invalid. Reconnect from the app.
        </p>
      </AuthFrame>
    );
  const runtime = await getCloudRuntime();
  const actor = await runtime.identity.authenticate(
    (await cookies()).get(cloudSessionCookie)?.value ?? "",
  );
  if (!actor) redirect(`/cloud/login?authorize=${id.data}`);
  try {
    return (
      <CloudAuthorizationForm
        consent={await runtime.authorization.consent(actor, id.data)}
      />
    );
  } catch (error) {
    if (!isCloudError(error)) throw error;
    return (
      <AuthFrame>
        <h1>Connect app</h1>
        <p role="alert">{error.message}</p>
      </AuthFrame>
    );
  }
}
