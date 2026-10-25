import { CloudAuthForm } from "@/components/cloud/auth-form";
import { cloudId } from "@/lib/cloud-contract";
export default async function CloudLogin({
  searchParams,
}: {
  searchParams: Promise<{ authorize?: string }>;
}) {
  const authorization = cloudId.safeParse((await searchParams).authorize);
  return (
    <CloudAuthForm
      authorizationId={authorization.success ? authorization.data : undefined}
    />
  );
}
