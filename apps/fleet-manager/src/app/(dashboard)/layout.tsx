import { ApplicationShell } from "@machdoch/product-ui/application-shell";
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
    <ApplicationShell
      className="fleet-dashboard"
      topbar={
        <>
          <a href="#fleet-content" className="fleet-skip-link">
            Skip to content
          </a>
          <header className="fleet-dashboard-topbar">
            <span className="font-semibold">Fleet Manager</span>
            <span className="ml-auto min-w-0 truncate text-muted-foreground">
              {session.username}
            </span>
            <LogoutButton />
          </header>
        </>
      }
      navigation={<DashboardNavigation settingsEnabled={settingsEnabled} />}
    >
      <main
        id="fleet-content"
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-7 sm:py-8 lg:px-10 lg:py-10 xl:px-12">
          {children}
        </div>
      </main>
    </ApplicationShell>
  );
}
