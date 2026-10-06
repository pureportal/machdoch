import type { ProductSnapshot } from "@machdoch/fleet-protocol";
import type { FleetOperationTransport } from "@machdoch/product-ui/fleet-operation-transport";
import { isConfiguredModelProvider } from "../../core/runtime-contract.generated.js";
import { replaceDiscoveredModelCapabilities } from "../../core/model-capabilities.js";
import type { RemoteRalphPlatform } from "./ralph/ralph-platform";
import type { UserInternalTaskModelSettings } from "./runtime";

export function createRemoteTaskPlatform(
  snapshot: ProductSnapshot,
  transport: FleetOperationTransport,
  internalTaskModel: UserInternalTaskModelSettings,
): RemoteRalphPlatform {
  const platform: RemoteRalphPlatform = {
    ...transport,
    catalog: {
      generatedAt: Date.now(),
      providers: (snapshot.shell?.composer?.modelCatalog ?? []).flatMap(
        (provider) =>
          isConfiguredModelProvider(provider.provider)
            ? [
                {
                  ...provider,
                  provider: provider.provider,
                  source: "fleet",
                  models: provider.models.map((model) => ({
                    ...model,
                    capabilities: { reasoningModes: model.reasoningOptions },
                  })),
                },
              ]
            : [],
      ),
    },
    providers: (snapshot.shell?.runtime?.providerStatuses ?? []).flatMap(
      (provider) =>
        isConfiguredModelProvider(provider.provider)
          ? [
              {
                provider: provider.provider,
                configured: provider.available,
                source: "user" as const,
              },
            ]
          : [],
    ),
    internalTaskModel,
  };
  for (const provider of platform.catalog.providers)
    replaceDiscoveredModelCapabilities(provider.provider, provider.models);
  return platform;
}
