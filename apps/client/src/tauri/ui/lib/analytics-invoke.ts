import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { trackOperation } from "@machdoch/analytics/operations";
import { invocationOperation } from "@machdoch/analytics/catalog";

export const invoke: typeof nativeInvoke = (...args) =>
  trackOperation(invocationOperation(args[0], args[1]), () =>
    nativeInvoke(...args),
  );
