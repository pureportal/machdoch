"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import type { NavigationSection } from "./navigation";

const storageKey = "machdoch.cloud.hidden-intros";

function storedHrefs(): string[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    localStorage.removeItem(storageKey);
    return [];
  }
}

export function useHiddenIntros(): {
  hidden: (href: string) => boolean;
  toggle: (href: string) => void;
} {
  const [hrefs, setHrefs] = useState<string[] | null>(null);
  useEffect(() => setHrefs(storedHrefs()), []);
  const toggle = useCallback((href: string) => {
    setHrefs((current) => {
      const list = current ?? [];
      const next = list.includes(href)
        ? list.filter((entry) => entry !== href)
        : [...list, href];
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }, []);
  return {
    hidden: (href) => hrefs === null || hrefs.includes(href),
    toggle,
  };
}

export function SectionIntro({
  section,
  hidden,
  onHide,
}: {
  section: NavigationSection;
  hidden: boolean;
  onHide: () => void;
}) {
  return (
    <>
      {section.pages.length > 1 && (
        <nav aria-label={section.label} className="cloud-section-navigation">
          {section.pages.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              aria-current={page === section.page ? "page" : undefined}
            >
              {page.label}
            </Link>
          ))}
        </nav>
      )}
      {!hidden && (
        <div className="cloud-section-intro">
          <Info size={15} aria-hidden="true" />
          <p>{section.page.description}</p>
          <button
            type="button"
            aria-label="Hide page description"
            onClick={onHide}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
