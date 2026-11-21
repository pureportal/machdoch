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
  inert = false,
}: {
  topbar: ReactNode;
  navigation: ReactNode;
  notices?: ReactNode;
  overlays?: ReactNode;
  children: ReactNode;
  className?: string;
  inert?: boolean;
}): React.ReactElement {
  useProductViewport();
  return (
    <div className={`m-application-shell ${className}`}>
      <div className="m-application-content" inert={inert}>
        {topbar}
        {notices}
        <div className="m-application-body">
          {navigation}
          {children}
        </div>
      </div>
      {overlays}
    </div>
  );
}
