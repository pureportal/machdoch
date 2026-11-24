import { useState, type ComponentProps, type JSX, type ReactNode } from "react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { MediaModelInstallDialog } from "./media-model-install-dialog";

export const MediaModelInstallButton = ({
  model,
  onInstalled,
  children,
  ...buttonProps
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  model: Pick<MediaModelDescriptor, "id" | "displayName">;
  onInstalled: () => Promise<void>;
  children: ReactNode;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      {open ? (
        <MediaModelInstallDialog
          model={model}
          onClose={() => setOpen(false)}
          onInstalled={onInstalled}
        />
      ) : null}
    </>
  );
};
