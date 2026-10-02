import type { ReactNode } from "react";

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h1>
      {children ? (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </header>
  );
}
