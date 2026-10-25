"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { startBrowserAnalytics, trackRoute } from "@machdoch/analytics/browser";

export function FleetAnalytics({ version }: { version: string }): null {
  const pathname = usePathname();
  const authenticationPage = [
    "/cloud/login",
    "/cloud/join",
    "/cloud/sign-in",
    "/cloud/authorize",
    "/cloud/sso",
  ].includes(pathname);
  useEffect(() => {
    if (authenticationPage) return;
    return startBrowserAnalytics({
      app: "fleet",
      version,
      development: process.env.NODE_ENV !== "production",
    });
  }, [version, authenticationPage]);
  useEffect(() => {
    if (!authenticationPage) trackRoute(pathname);
  }, [pathname, authenticationPage]);
  return null;
}
