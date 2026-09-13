import { Dialog } from "radix-ui";
import { useCallback, useRef, useState, type ReactNode } from "react";

export function ProductModal({
  children,
  className = "m-media-modal",
  title,
  description,
  titleHidden = false,
  dismissible = true,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  title: string;
  description?: string;
  titleHidden?: boolean;
  dismissible?: boolean;
  onClose: () => void;
}): React.ReactElement {
  const returnFocus = useRef<HTMLElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const mount = useCallback((element: HTMLSpanElement | null) => {
    setContainer(element?.closest<HTMLElement>(".machdoch-product") ?? null);
  }, []);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      <span hidden ref={mount} />
      {container ? (
        <Dialog.Portal container={container}>
          <Dialog.Overlay className="m-media-modal-backdrop">
            <Dialog.Content
              className={className}
              {...(description ? {} : { "aria-describedby": undefined })}
              onOpenAutoFocus={() => {
                returnFocus.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (returnFocus.current?.isConnected)
                  returnFocus.current.focus();
              }}
            >
              <Dialog.Title
                className={
                  titleHidden ? "m-product-visually-hidden" : undefined
                }
              >
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description>{description}</Dialog.Description>
              ) : null}
              {children}
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
