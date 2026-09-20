import { Copy } from "lucide-react";
import type { ReactElement } from "react";
import { copyText } from "../../lib/clipboard";
import { ContextActionMenu } from "./context-action-menu";

export interface CopyMenuValue {
  label: string;
  value: string;
}

export const CopyContextMenu = ({
  children,
  values,
  selectable = true,
}: {
  children: ReactElement;
  values: readonly CopyMenuValue[] | (() => readonly CopyMenuValue[]);
  selectable?: boolean;
}) => (
  <ContextActionMenu
    label="Copy actions"
    selectable={selectable}
    actions={() =>
      (typeof values === "function" ? values() : values).map(
        ({ label, value }) => ({
          label,
          icon: Copy,
          disabled: !value,
          onSelect: () => copyText(value),
        }),
      )
    }
  >
    {children}
  </ContextActionMenu>
);
