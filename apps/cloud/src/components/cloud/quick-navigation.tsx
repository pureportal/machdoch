"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  ArrowUpRight,
  Bookmark,
  Plus,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { CloudIssueSummary, CloudRole } from "@/lib/cloud-contract";
import type { SavedView } from "@/lib/cloud-view-contract";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cloudRequest } from "./api-client";
import { clientNavigation, navigationForRole } from "./navigation";

const searchDelayMs = 150;

function viewHref(view: SavedView): string {
  const query = new URLSearchParams(
    view.filters as Record<string, string>,
  ).toString();
  return `/cloud/issues${query ? `?${query}` : ""}`;
}

export function QuickNavigation({
  role,
  views,
  canCreate,
}: {
  role: CloudRole;
  views: SavedView[];
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<CloudIssueSummary[]>([]);
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
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) {
      setIssues([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void cloudRequest<{ issues: CloudIssueSummary[] }>(
        `issues/search?query=${encodeURIComponent(trimmed)}`,
        { signal: abort.signal },
      )
        .then((result) => setIssues(result.issues))
        .catch(() => undefined);
    }, searchDelayMs);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, open]);
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
  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }
  return (
    <>
      <button
        className="cloud-quick-navigation"
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Go to page"
        aria-keyshortcuts="Control+k Meta+k"
      >
        <Search size={14} />
        <span>Search or go to…</span>
        <kbd>⌘K</kbd>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
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
          <Command className="cloud-command" label="Pages" shouldFilter>
            <div className="flex items-center gap-3 border-b px-5 pr-12">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input
                placeholder="Search issues, pages and actions…"
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
                value={query}
                onValueChange={setQuery}
              />
            </div>
            <Command.List className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
              <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
                No matches.
              </Command.Empty>
              {issues.length > 0 && (
                <Command.Group heading="Issues" forceMount>
                  {issues.map((issue) => (
                    <Command.Item
                      key={issue.id}
                      forceMount
                      value={`issue ${issue.identifier} ${issue.title} ${query}`}
                      onSelect={() => go(`/cloud/issues/${issue.id}`)}
                    >
                      <span className="cloud-state" data-state={issue.state} />
                      <span className="cloud-issue-key">
                        {issue.identifier}
                      </span>
                      <span className="flex-1 truncate">{issue.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions">
                {canCreate && (
                  <Command.Item
                    value="Create new issue"
                    onSelect={() => go("/cloud/issues?new=1")}
                  >
                    <Plus className="size-4" />
                    <span className="flex-1">New issue</span>
                    <kbd>C</kbd>
                  </Command.Item>
                )}
                <Command.Item
                  value="Ask a question"
                  onSelect={() =>
                    go(
                      query.trim()
                        ? `/cloud/chat?prompt=${encodeURIComponent(query.trim())}`
                        : "/cloud/chat",
                    )
                  }
                >
                  <Sparkles className="size-4" />
                  <span className="flex-1">Ask machdoch</span>
                </Command.Item>
              </Command.Group>
              {views.length > 0 && (
                <Command.Group heading="Views">
                  {views.map((view) => (
                    <Command.Item
                      key={view.id}
                      value={`view ${view.name}`}
                      onSelect={() => go(viewHref(view))}
                    >
                      <Bookmark className="size-4" />
                      <span className="flex-1">{view.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {groups.map((group) => (
                <Command.Group key={group.label} heading={group.label}>
                  {group.items.map(({ href, label, icon: Icon }) => (
                    <Command.Item
                      key={href}
                      value={`${group.label} ${label}`}
                      onSelect={() => go(href)}
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
