import { WorkspaceDefaultIcon } from "@machdoch/product-ui";
import type { JSX } from "react";

export const WorkspaceDefaultIndicator = (): JSX.Element => (
  <WorkspaceDefaultIcon
    aria-hidden="true"
    className="app-composer-default-indicator pointer-events-none absolute right-0 top-0 size-2.5 fill-current text-sky-300"
  />
);
