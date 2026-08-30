import { RadioTower } from "lucide-react";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";
import { pageSession } from "@/server/page-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage(): Promise<React.ReactElement> {
  if (await pageSession()) redirect("/instances");
  return (
    <main className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5 text-lg font-semibold">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <RadioTower className="size-5" />
          </span>
          Fleet Manager
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
