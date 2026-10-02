import Link from "next/link";
import { FleetBrand } from "@/components/fleet-brand";
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
    <div className="fleet-dashboard min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#fleet-content" className="fleet-skip-link">
        Skip to content
      </a>
      <aside className="fleet-sidebar flex flex-col lg:sticky lg:top-0 lg:h-dvh">
        <div className="flex h-20 items-center justify-between px-5 lg:h-28 lg:justify-start lg:px-6">
          <Link
            href="/instances"
            aria-label="Fleet Manager overview"
            className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FleetBrand />
          </Link>
          <div className="lg:hidden">
            <LogoutButton />
          </div>
        </div>
        <DashboardNavigation settingsEnabled={settingsEnabled} />
        <div className="mt-auto hidden items-center gap-3 border-t border-white/10 px-5 py-5 lg:flex">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold"
            aria-hidden="true"
          >
            {session.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {session.username}
          </span>
          <LogoutButton />
        </div>
      </aside>
      <main id="fleet-content" tabIndex={-1} className="min-w-0 outline-none">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-7 sm:py-8 lg:px-10 lg:py-10 xl:px-12">
          {children}
        </div>
      </main>
    </div>
  );
}
