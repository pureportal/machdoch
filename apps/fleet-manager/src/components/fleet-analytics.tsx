"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { startBrowserAnalytics, trackRoute } from "@machdoch/analytics/browser";

export function FleetAnalytics({ version }: { version: string }): null {
  const pathname = usePathname();
  useEffect(
    () =>
      startBrowserAnalytics({
        app: "fleet",
        version,
        development: process.env.NODE_ENV !== "production",
      }),
    [version],
  );
  useEffect(() => trackRoute(pathname), [pathname]);
  return null;
}
