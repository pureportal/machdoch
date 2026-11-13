"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { isNavigationActive, type NavigationItem } from "./navigation";

const collapsedStorageKey = "machdoch.cloud.sidebar.collapsed";

export function useCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(collapsedStorageKey) ?? "[]",
      ) as unknown;
      if (Array.isArray(stored))
        setCollapsed(stored.filter((entry) => typeof entry === "string"));
    } catch {
      localStorage.removeItem(collapsedStorageKey);
    }
  }, []);
  return {
    isOpen: (key: string, initiallyOpen = true) =>
      collapsed.includes(key) !== initiallyOpen,
    toggle: (key: string) =>
      setCollapsed((current) => {
        const next = current.includes(key)
          ? current.filter((entry) => entry !== key)
          : [...current, key];
        localStorage.setItem(collapsedStorageKey, JSON.stringify(next));
        return next;
      }),
  };
}

export type CollapsedSections = ReturnType<typeof useCollapsed>;

export function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="cloud-navigation-group">
      <button
        type="button"
        className="cloud-navigation-section"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
        <ChevronRight size={11} aria-hidden="true" />
      </button>
      {open && children}
    </div>
  );
}

export function SidebarLink({
  item,
  count = 0,
  countLabel,
  onNavigate,
}: {
  item: Omit<NavigationItem, "icon"> & { icon?: NavigationItem["icon"] };
  count?: number;
  countLabel?: string;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={
        (item.paths ?? [item.href]).some((href) =>
          isNavigationActive(href, pathname, new URLSearchParams(search)),
        )
          ? "page"
          : undefined
      }
    >
      {Icon && <Icon size={15} strokeWidth={1.7} />}
      <span>{item.label}</span>
      {count > 0 && (
        <span className="cloud-navigation-badge">
          {count > 99 ? "99+" : count}
          {countLabel && <span className="sr-only"> {countLabel}</span>}
        </span>
      )}
    </Link>
  );
}
