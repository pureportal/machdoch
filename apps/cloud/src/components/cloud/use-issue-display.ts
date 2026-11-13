"use client";

import { useMemo, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  hiddenPropertyList,
  parseHiddenIssueProperties,
  parseHiddenPropertyList,
  toggleIssueProperty,
  type IssueDisplayProperty,
} from "@/lib/issue-display";

const storageKey = "machdoch.cloud.issue-display.hidden";
const changeEvent = "machdoch:issue-display";
export const hiddenPropertiesParameter = "hide";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(changeEvent, onChange);
  };
}

export function useIssueDisplay() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const fromView = search.get(hiddenPropertiesParameter);
  const stored = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(storageKey),
    () => null,
  );
  const hidden = useMemo(
    () =>
      fromView === null
        ? parseHiddenIssueProperties(stored)
        : parseHiddenPropertyList(fromView),
    [fromView, stored],
  );
  return {
    hidden,
    shows: (property: IssueDisplayProperty) => !hidden.has(property),
    toggle: (property: IssueDisplayProperty) => {
      const next = toggleIssueProperty(hidden, property);
      if (fromView !== null) {
        const parameters = new URLSearchParams(search);
        parameters.set(
          hiddenPropertiesParameter,
          hiddenPropertyList(new Set(next)),
        );
        router.replace(`${pathname}?${parameters}`, { scroll: false });
        return;
      }
      localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(changeEvent));
    },
  };
}
