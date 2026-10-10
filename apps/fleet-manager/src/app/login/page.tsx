import { FleetBrand } from "@/components/fleet-brand";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";
import { pageSession } from "@/server/page-auth";
import { AnalyticsPrivacyControl } from "@machdoch/analytics/privacy-control";

export const dynamic = "force-dynamic";

export default async function LoginPage(): Promise<React.ReactElement> {
  if (await pageSession()) redirect("/instances");
  return (
    <main className="fleet-login grid min-h-dvh place-items-center px-4 py-10">
      <div className="relative w-full max-w-[420px]">
        <FleetBrand className="mb-8 justify-center" />
        <LoginForm />
        <details className="mt-5 text-sm text-muted-foreground">
          <summary className="cursor-pointer">Privacy</summary>
          <AnalyticsPrivacyControl className="mt-3" />
        </details>
      </div>
    </main>
  );
}
