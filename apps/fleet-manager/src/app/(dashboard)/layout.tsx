import { RadioTower } from "lucide-react";
import { DashboardNavigation } from "@/components/dashboard-navigation";
import { LogoutButton } from "@/components/logout-button";
import { requirePageSession } from "@/server/page-auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const session = await requirePageSession();
  const settingsEnabled = getRuntime().settingsCipher !== null;
  return (
    <div className="fleet-dashboard min-h-dvh lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b border-border bg-card/80 backdrop-blur lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-16 items-center justify-between px-5 lg:justify-start">
          <div className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <RadioTower className="size-4" />
            </span>
            Fleet Manager
          </div>
          <div className="lg:hidden">
            <LogoutButton />
          </div>
        </div>
        <DashboardNavigation settingsEnabled={settingsEnabled} />
        <div className="absolute bottom-0 hidden w-[239px] items-center justify-between border-t border-border px-5 py-4 lg:flex">
          <span className="truncate text-sm text-muted-foreground">
            {session.username}
          </span>
          <LogoutButton />
        </div>
      </aside>
      <main className="min-w-0">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
