import { useSyncExternalStore } from "react";
import { getProviderModelCatalogStore } from "./runtime";

const subscribeDisabled = () => () => {};

export function useProviderModelCatalog(enabled = true) {
  const store = getProviderModelCatalogStore();
  const state = useSyncExternalStore(
    enabled ? store.subscribe : subscribeDisabled,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { ...state, refresh: store.refresh };
}
