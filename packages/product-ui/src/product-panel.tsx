import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, type ReactNode } from "react";

export function ProductPanel({
  open,
  onOpenChange,
  title,
  side,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side: "left" | "right";
  children: ReactNode;
}): React.ReactElement {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Overlay className="m-product-panel-scrim" />
      <Dialog.Content
        className="m-product-panel"
        data-side={side}
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <div className="m-product-panel-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close
            className="m-product-icon-button"
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <X aria-hidden="true" />
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
