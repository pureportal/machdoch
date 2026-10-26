"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { ArrowUpRight, Search, UserRound } from "lucide-react";
import type { CloudRole } from "@/lib/cloud-contract";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { clientNavigation, navigationForRole } from "./navigation";

export function QuickNavigation({ role }: { role: CloudRole }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const groups = [
    ...navigationForRole(role),
    ...(["owner", "admin"].includes(role)
      ? [{ label: "Client management", items: clientNavigation.slice(1) }]
      : []),
    {
      label: "Personal",
      items: [{ href: "/cloud/account", label: "Account", icon: UserRound }],
    },
  ];
  return (
    <>
      <button
        className="cloud-quick-navigation"
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Go to page"
        aria-keyshortcuts="Control+k Meta+k"
      >
        <Search size={15} />
        <span>Go to…</span>
        <kbd>⌘ / Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="cloud-command-dialog max-w-xl gap-0 overflow-hidden p-0 sm:p-0"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocus.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogTitle className="sr-only">Go to page</DialogTitle>
          <Command className="cloud-command" label="Pages">
            <div className="flex items-center gap-3 border-b px-5 pr-12">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input
                placeholder="Find a page…"
                className="h-14 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
            <Command.List className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
              <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
                No matching pages.
              </Command.Empty>
              {groups.map((group) => (
                <Command.Group key={group.label} heading={group.label}>
                  {group.items.map(({ href, label, icon: Icon }) => (
                    <Command.Item
                      key={href}
                      value={`${group.label} ${label}`}
                      onSelect={() => {
                        setOpen(false);
                        router.push(href);
                      }}
                    >
                      <Icon className="size-4" />
                      <span className="flex-1">{label}</span>
                      <ArrowUpRight className="size-3.5 opacity-40" />
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
