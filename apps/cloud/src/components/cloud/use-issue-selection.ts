"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudIssueSummary } from "@/lib/cloud-contract";

export function useIssueSelection(
  issues: CloudIssueSummary[],
  groups: { issues: CloudIssueSummary[] }[],
) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => {
    setSelected((current) => {
      const known = new Set(issues.map((issue) => issue.id));
      const next = new Set([...current].filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [issues]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog]"))
        setSelected((current) => (current.size ? new Set() : current));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const toggle = useCallback(
    (id: string, range: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        if (range && anchor.current) {
          const ordered = groups.flatMap((group) =>
            group.issues.map((issue) => issue.id),
          );
          const from = ordered.indexOf(anchor.current);
          const to = ordered.indexOf(id);
          for (
            let index = Math.min(from, to);
            index <= Math.max(from, to);
            index += 1
          )
            next.add(ordered[index]!);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        anchor.current = id;
        return next;
      });
    },
    [groups],
  );
  const clear = useCallback(() => setSelected(new Set()), []);
  return {
    selected,
    selectedIssues: issues.filter((issue) => selected.has(issue.id)),
    toggle,
    clear,
  };
}
