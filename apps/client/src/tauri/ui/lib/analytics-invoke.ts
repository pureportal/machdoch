import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { trackOperation } from "@machdoch/analytics/operations";
import { invocationOperation } from "@machdoch/analytics/catalog";

export const invoke: typeof nativeInvoke = (command, args, options) =>
  trackOperation(invocationOperation(command, args), () =>
    nativeInvoke(command, args, options),
  );
