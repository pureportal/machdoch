import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { ProviderModelCatalogSnapshot } from "../model-catalog";
import type {
  RuntimeProviderAvailability,
  UserInternalTaskModelSettings,
} from "../runtime";

export interface RemoteRalphPlatform extends FleetOperationTransport {
  catalog: ProviderModelCatalogSnapshot;
  providers: RuntimeProviderAvailability[];
  internalTaskModel: UserInternalTaskModelSettings;
}

let remotePlatform: RemoteRalphPlatform | null = null;

export function configureRemoteRalphPlatform(
  platform: RemoteRalphPlatform,
): void {
  if (remotePlatform) throw new Error("A RALPH host is already connected.");
  remotePlatform = platform;
}

export const getRemoteRalphPlatform = (): RemoteRalphPlatform | null =>
  remotePlatform;
