import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TwoFactorChallenge } from "@/components/cloud/two-factor-challenge";
import { TwoFactorEnrollment } from "@/components/cloud/two-factor-enrollment";
import { cloudId } from "@/lib/cloud-contract";
import { cloudSessionCookie } from "@/server/cloud/identity";
import { getCloudRuntime } from "@/server/cloud/runtime";

export const dynamic = "force-dynamic";

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ authorize?: string }>;
}) {
  const authorization = cloudId.safeParse((await searchParams).authorize);
  const destination = authorization.success
    ? `/cloud/authorize?requestId=${authorization.data}`
    : "/cloud/issues";
  const signIn = authorization.success
    ? `/cloud/login?authorize=${authorization.data}`
    : "/cloud/login";
  const runtime = await getCloudRuntime();
  const token = (await cookies()).get(cloudSessionCookie)?.value ?? "";
  if (await runtime.identity.authenticate(token)) redirect(destination);
  const challenge = await runtime.authentication.twoFactor.challenge(token);
  if (!challenge) redirect(signIn);
  return challenge.enrolled ? (
    <TwoFactorChallenge destination={destination} signIn={signIn} />
  ) : (
    <TwoFactorEnrollment destination={destination} signIn={signIn} />
  );
}
