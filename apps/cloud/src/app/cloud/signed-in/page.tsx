import { CheckCircle2, XCircle } from "lucide-react";
import { AuthFrame } from "@/components/cloud/auth-frame";

export default async function SignedIn({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const result = (await searchParams).result;
  return (
    <AuthFrame>
      {result === "signed-in" ? (
        <div className="cloud-client-sign-in" role="status">
          <CheckCircle2 className="cloud-client-sign-in-result" />
          <h1>You're signed in</h1>
          <p>Return to Machdoch. You can close this tab.</p>
        </div>
      ) : (
        <div className="cloud-client-sign-in" role="alert">
          <XCircle className="cloud-client-sign-in-result" data-failed="" />
          <h1>
            {result === "canceled" ? "Sign-in canceled" : "Sign-in failed"}
          </h1>
          <p>Return to Machdoch to try again.</p>
        </div>
      )}
    </AuthFrame>
  );
}
