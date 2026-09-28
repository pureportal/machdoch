import { Star } from "lucide-react";
import type { JSX } from "react";

export const WorkspaceDefaultIndicator = (): JSX.Element => (
  <Star
    aria-hidden="true"
    className="app-composer-default-indicator pointer-events-none absolute right-0 top-0 size-2.5 fill-current text-sky-300"
  />
);
