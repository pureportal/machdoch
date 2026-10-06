import type { ReactNode, Ref } from "react";

export function ApplicationShell({
  topbar,
  navigation,
  notices,
  overlays,
  children,
  className = "",
  viewportRef,
}: {
  topbar: ReactNode;
  navigation: ReactNode;
  notices?: ReactNode;
  overlays?: ReactNode;
  children: ReactNode;
  className?: string;
  viewportRef?: Ref<HTMLDivElement>;
}): React.ReactElement {
  return (
    <div ref={viewportRef} className={`m-application-shell ${className}`}>
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
