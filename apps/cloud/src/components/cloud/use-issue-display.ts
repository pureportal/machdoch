"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  parseHiddenIssueProperties,
  toggleIssueProperty,
  type IssueDisplayProperty,
} from "@/lib/issue-display";

const storageKey = "machdoch.cloud.issue-display.hidden";
const changeEvent = "machdoch:issue-display";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(changeEvent, onChange);
  };
}

export function useIssueDisplay() {
  const stored = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(storageKey),
    () => null,
  );
  const hidden = useMemo(() => parseHiddenIssueProperties(stored), [stored]);
  return {
    hidden,
    shows: (property: IssueDisplayProperty) => !hidden.has(property),
    toggle: (property: IssueDisplayProperty) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify(toggleIssueProperty(hidden, property)),
      );
      window.dispatchEvent(new Event(changeEvent));
    },
  };
}
