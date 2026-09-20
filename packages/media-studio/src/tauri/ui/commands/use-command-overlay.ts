import * as React from "react";
import {
  commandOverlayStore,
  type CommandOverlayRegistration,
} from "./command-overlay-store";

export interface UseCommandOverlayOptions extends CommandOverlayRegistration {
  open: boolean;
}

export const useCommandOverlay = ({
  open,
  id,
  kind,
  allowGlobalCommands = [],
  dismiss,
}: UseCommandOverlayOptions): void => {
  const dismissRef = React.useRef(dismiss);
  dismissRef.current = dismiss;
  const allowKey = allowGlobalCommands.join("\u0000");

  React.useEffect(() => {
    if (!open) return;
    return commandOverlayStore.register({
      id,
      kind,
      allowGlobalCommands,
      dismiss: dismiss ? () => dismissRef.current?.() : undefined,
    });
  }, [allowKey, id, kind, open]);
};
