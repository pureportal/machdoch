"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, Command, LogOut, Menu, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { SavedView } from "@/lib/cloud-view-contract";
import type { CloudFavorite } from "@/lib/cloud-favorite-contract";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cloudRequest } from "./api-client";
import { inboxChangedEvent } from "./inbox";
import {
  clientNavigation,
  isNavigationActive,
  navigationForRole,
  pageNavigation,
} from "./navigation";
import { PersonAvatar } from "./person-avatar";
import { QuickNavigation } from "./quick-navigation";
import { Sidebar } from "./sidebar";
import { ToastProvider } from "./toast";
import { TeamKeysProvider } from "./cloud-markdown";
import { AgentShellProvider } from "./agent/agent-shell";
import { AgentDock } from "./agent/agent-panel";
import { favoritesChangedEvent, triageChangedEvent } from "./events";

const unreadPollMs = 30_000;

function useUnreadCount(initial: number): number {
  const [unread, setUnread] = useState(initial);
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      void cloudRequest<{ unread: number }>("inbox/unread")
        .then((result) => setUnread(result.unread))
        .catch(() => undefined);
    };
    const timer = setInterval(refresh, unreadPollMs);
    window.addEventListener("focus", refresh);
    window.addEventListener(inboxChangedEvent, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(inboxChangedEvent, refresh);
    };
  }, []);
  return unread;
}

function useFavorites(initial: CloudFavorite[]): CloudFavorite[] {
  const [favorites, setFavorites] = useState(initial);
  useEffect(() => setFavorites(initial), [initial]);
  useEffect(() => {
    const refresh = () =>
      void cloudRequest<{ favorites: CloudFavorite[] }>("favorites")
        .then((result) => setFavorites(result.favorites))
        .catch(() => undefined);
    window.addEventListener(favoritesChangedEvent, refresh);
    return () => window.removeEventListener(favoritesChangedEvent, refresh);
  }, []);
  return favorites;
}

function useTriageCounts(
  initial: Record<string, number>,
): Record<string, number> {
  const [counts, setCounts] = useState(initial);
  useEffect(() => setCounts(initial), [initial]);
  useEffect(() => {
    const refresh = () =>
      void cloudRequest<{ counts: Record<string, number> }>("triage/counts")
        .then((result) => setCounts(result.counts))
        .catch(() => undefined);
    window.addEventListener(triageChangedEvent, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(triageChangedEvent, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return counts;
}

export function CloudShell({
  workspace,
  unread: initialUnread,
  views,
  favorites: initialFavorites,
  triage: initialTriage,
  children,
}: {
  workspace: CloudWorkspace;
  unread: number;
  views: SavedView[];
  favorites: CloudFavorite[];
  triage: Record<string, number>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const managingClients = clientNavigation.some(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const unread = useUnreadCount(initialUnread);
  const favorites = useFavorites(initialFavorites);
  const triage = useTriageCounts(initialTriage);
  const writable = workspace.actor.role !== "viewer";
  const items = [
    ...navigationForRole(workspace.actor.role).flatMap((group) => group.items),
    ...clientNavigation,
    ...pageNavigation,
  ];
  const current =
    items.find((item) =>
      isNavigationActive(item.href, pathname, new URLSearchParams(search)),
    ) ??
    items.find(
      (item) =>
        !item.href.includes("?") &&
        (pathname === item.href || pathname.startsWith(`${item.href}/`)),
    );
  useEffect(() => {
    const media = matchMedia("(min-width: 801px)");
    const close = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, []);
  const navigation = (
    <>
      <div className="cloud-sidebar-header">
        <Link
          className="cloud-brand"
          href="/cloud/issues"
          onClick={() => setOpen(false)}
        >
          <span className="cloud-brand-mark">
            <Command size={14} strokeWidth={2.4} />
          </span>
          <span className="cloud-brand-text">
            <span>{workspace.organization.name}</span>
          </span>
        </Link>
        {writable && workspace.teams.length > 0 && (
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="cloud-sidebar-action"
          >
            <Link
              href="/cloud/issues?new=1"
              aria-label="New issue"
              onClick={() => setOpen(false)}
            >
              <SquarePen size={15} />
            </Link>
          </Button>
        )}
      </div>
      <Sidebar
        workspace={workspace}
        unread={unread}
        favorites={favorites}
        triage={triage}
        onNavigate={() => setOpen(false)}
      />
      <div className="cloud-sidebar-footer">
        <Link
          href="/cloud/account"
          onClick={() => setOpen(false)}
          className="cloud-account-link"
          aria-current={pathname === "/cloud/account" ? "page" : undefined}
        >
          <PersonAvatar
            name={workspace.actor.name}
            className="cloud-avatar-small"
          />
          <span>{workspace.actor.name}</span>
        </Link>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Sign out"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void cloudRequest("auth/logout", { method: "POST" })
              .then(() => location.assign("/cloud/login"))
              .catch((reason: Error) => {
                setError(reason.message);
                setSigningOut(false);
              });
          }}
        >
          <LogOut size={15} />
        </Button>
      </div>
      {error && (
        <p className="cloud-error px-3" role="alert">
          {error}
        </p>
      )}
    </>
  );
  return (
    <ToastProvider>
      <TeamKeysProvider keys={workspace.teams.map((team) => team.key)}>
        <AgentShellProvider>
          <div
            className="cloud-shell"
            data-cloud-accent={workspace.organization.accent}
          >
            <a className="fleet-skip-link" href="#cloud-content">
              Skip to content
            </a>
            <aside className="cloud-sidebar">{navigation}</aside>
            <div className="cloud-workspace">
              <header className="cloud-topbar">
                <Sheet open={open} onOpenChange={setOpen}>
                  <SheetTrigger asChild>
                    <Button
                      className="cloud-menu-trigger"
                      variant="ghost"
                      size="icon"
                      aria-label="Open navigation"
                    >
                      <Menu />
                    </Button>
                  </SheetTrigger>
                  <SheetContent aria-describedby={undefined}>
                    <SheetTitle className="sr-only">Navigation</SheetTitle>
                    <div className="cloud-sidebar cloud-sidebar-mobile">
                      {navigation}
                    </div>
                  </SheetContent>
                </Sheet>
                <div className="cloud-breadcrumb" aria-label="Current location">
                  <span>{workspace.organization.name}</span>
                  <ChevronRight size={13} />
                  <span>{current?.label ?? "Account"}</span>
                </div>
                <QuickNavigation
                  role={workspace.actor.role}
                  views={views}
                  canCreate={writable && workspace.teams.length > 0}
                />
              </header>
              <main id="cloud-content" tabIndex={-1} className="cloud-content">
                {managingClients && (
                  <nav aria-label="Clients" className="cloud-client-navigation">
                    {clientNavigation.map(({ href, label, icon: Icon }) => (
                      <Link
                        key={href}
                        href={href}
                        aria-current={pathname === href ? "page" : undefined}
                      >
                        <Icon size={15} />
                        {label}
                      </Link>
                    ))}
                  </nav>
                )}
                {children}
              </main>
            </div>
            <AgentDock workspace={workspace} />
          </div>
        </AgentShellProvider>
      </TeamKeysProvider>
    </ToastProvider>
  );
}
