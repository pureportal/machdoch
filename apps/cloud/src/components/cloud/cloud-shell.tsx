"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Bookmark,
  ChevronRight,
  Command,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { SavedView } from "@/lib/cloud-view-contract";
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
} from "./navigation";
import { PersonAvatar } from "./person-avatar";
import { QuickNavigation } from "./quick-navigation";
import { ToastProvider, useToast } from "./toast";
import { useRouter } from "next/navigation";

const unreadPollMs = 30_000;

function viewHref(view: SavedView): string {
  const query = new URLSearchParams(
    view.filters as Record<string, string>,
  ).toString();
  return `/cloud/issues${query ? `?${query}` : ""}`;
}

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

function SavedViews({
  views,
  onNavigate,
}: {
  views: SavedView[];
  onNavigate: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  if (!views.length) return null;
  return (
    <div className="cloud-navigation-group">
      <span className="cloud-navigation-label">Views</span>
      {views.map((view) => {
        const href = viewHref(view);
        const active =
          pathname === "/cloud/issues" &&
          new URLSearchParams(
            view.filters as Record<string, string>,
          ).toString() === search.toString();
        return (
          <span className="cloud-navigation-view" key={view.id}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
            >
              <Bookmark size={15} strokeWidth={1.7} />
              <span>{view.name}</span>
            </Link>
            {view.owned && (
              <button
                type="button"
                aria-label={`Remove view ${view.name}`}
                onClick={() =>
                  void cloudRequest(`views/${view.id}/remove`, {
                    method: "POST",
                    body: {},
                  })
                    .then(() => router.refresh())
                    .catch((reason: Error) => toast(reason.message, "error"))
                }
              >
                <X size={13} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function CloudShell({
  workspace,
  unread: initialUnread,
  views,
  children,
}: {
  workspace: CloudWorkspace;
  unread: number;
  views: SavedView[];
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
  const groups = navigationForRole(workspace.actor.role);
  const current = [
    ...groups.flatMap((group) => group.items),
    ...clientNavigation,
  ].find((item) =>
    isNavigationActive(item.href, pathname, new URLSearchParams(search)),
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
      <Link
        className="cloud-brand"
        href="/cloud/issues"
        onClick={() => setOpen(false)}
      >
        <span className="cloud-brand-mark">
          <Command size={15} strokeWidth={2.4} />
        </span>
        <span className="cloud-brand-text">
          <span>{workspace.organization.name}</span>
          <small>
            machdoch<span className="cloud-brand-suffix">.cloud</span>
          </small>
        </span>
      </Link>
      <nav aria-label="Cloud navigation" className="cloud-navigation-groups">
        {groups.map((group) => (
          <div className="cloud-navigation-group" key={group.label}>
            <span className="cloud-navigation-label">{group.label}</span>
            {group.items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={
                  isNavigationActive(
                    href,
                    pathname,
                    new URLSearchParams(search),
                  ) ||
                  (href === "/instances" && managingClients)
                    ? "page"
                    : undefined
                }
              >
                <Icon size={15} strokeWidth={1.7} />
                <span>{label}</span>
                {href === "/cloud/inbox" && unread > 0 && (
                  <span className="cloud-navigation-badge">
                    {unread > 99 ? "99+" : unread}
                    <span className="sr-only"> unread</span>
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))}
        <SavedViews views={views} onNavigate={() => setOpen(false)} />
      </nav>
      <div className="cloud-sidebar-footer">
        <Link
          href="/cloud/account"
          onClick={() => setOpen(false)}
          className="cloud-account-link"
          aria-current={pathname === "/cloud/account" ? "page" : undefined}
        >
          <PersonAvatar name={workspace.actor.name} className="cloud-avatar-small" />
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
              canCreate={
                workspace.actor.role !== "viewer" && workspace.teams.length > 0
              }
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
      </div>
    </ToastProvider>
  );
}
