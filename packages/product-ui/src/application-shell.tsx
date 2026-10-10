"use client";

import type { ReactNode } from "react";
import { useProductViewport } from "./responsive-layout";

export function ApplicationShell({
  topbar,
  navigation,
  notices,
  overlays,
  children,
  className = "",
}: {
  topbar: ReactNode;
  navigation: ReactNode;
  notices?: ReactNode;
  overlays?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  useProductViewport();
  return (
    <div className={`m-application-shell ${className}`}>
      {topbar}
      {notices}
      <div className="m-application-body">
        {navigation}
        {children}
      </div>
      {overlays}
    </div>
  );
}
