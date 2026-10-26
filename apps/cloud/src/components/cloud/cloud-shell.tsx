"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronRight,
  ChevronsUpDown,
  Command,
  LogOut,
  Menu,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cloudRequest } from "./api-client";
import { clientNavigation, navigationForRole } from "./navigation";
import { PersonAvatar } from "./person-avatar";
import { QuickNavigation } from "./quick-navigation";

export function CloudShell({
  workspace,
  children,
}: {
  workspace: CloudWorkspace;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const managingClients = clientNavigation.some(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const groups = navigationForRole(workspace.actor.role);
  const current = [
    ...groups.flatMap((group) => group.items),
    ...clientNavigation,
  ].find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
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
          <Command size={19} strokeWidth={2.4} />
        </span>
        <span>
          machdoch<span className="cloud-brand-suffix">.cloud</span>
        </span>
      </Link>
      <div className="cloud-organization">
        <span className="cloud-organization-mark">
          {workspace.organization.name.slice(0, 1).toUpperCase()}
        </span>
        <span>{workspace.organization.name}</span>
      </div>
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
                  pathname === href ||
                  pathname.startsWith(`${href}/`) ||
                  (href === "/instances" && managingClients)
                    ? "page"
                    : undefined
                }
              >
                <Icon size={17} strokeWidth={1.7} />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="cloud-sidebar-footer">
        <Link
          href="/cloud/account"
          onClick={() => setOpen(false)}
          className="cloud-account-link"
          aria-current={pathname === "/cloud/account" ? "page" : undefined}
        >
          <PersonAvatar name={workspace.actor.name} />
          <span>
            {workspace.actor.name}
            <small>Account</small>
          </span>
          <ChevronsUpDown size={14} />
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
          <LogOut size={16} />
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
          <QuickNavigation role={workspace.actor.role} />
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
  );
}
