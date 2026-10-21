import {
  ComposerModelPicker,
  type ComposerModelProvider,
} from "@machdoch/product-ui";
import { useMemo, type JSX } from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type {
  CommandDefinition,
  CommandPage,
  CommandPageGroup,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import {
  getCatalogModelsForProvider,
  getModelLabelForProvider,
  type RuntimeProvider,
} from "../../model-catalog";
import { getProviderLabel } from "@machdoch/client-ui/provider-labels";
import { loadProviderModelCatalog } from "../../runtime";
import { useProviderModelCatalog } from "../../use-provider-model-catalog";

export interface SessionModelPickerProps {
  chooserProviders: RuntimeProvider[];
  activeProvider: RuntimeProvider;
  activeModel: string;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  registerCommand?: boolean;
}

const EMPTY_COMMANDS: readonly CommandDefinition[] = [];

export const SessionModelPicker = ({
  chooserProviders,
  activeProvider,
  activeModel,
  onSessionModelSelection,
  registerCommand = true,
}: SessionModelPickerProps): JSX.Element => {
  const { catalog, loadingProviders, refresh } = useProviderModelCatalog();

  const providers = useMemo<ComposerModelProvider[]>(
    () =>
      chooserProviders.map((provider) => {
        const runtimeProvider = catalog?.providers.find(
          (entry) => entry.provider === provider,
        );
        return {
          id: provider,
          label: getProviderLabel(provider),
          available: runtimeProvider?.available === true,
          loading: loadingProviders.has(provider),
          ...(runtimeProvider?.error ? { error: runtimeProvider.error } : {}),
          models: getCatalogModelsForProvider(provider, catalog).map(
            (model) => ({ id: model.id, label: model.label }),
          ),
        };
      }),
    [catalog, chooserProviders, loadingProviders],
  );

  const modelCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "chat.session.model.select",
        title: "Choose session model",
        group: "Chat",
        keywords: ["provider"],
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          chooserProviders.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No providers are available" },
        children: async (_context, signal): Promise<CommandPage> => {
          try {
            const nextCatalog = await loadProviderModelCatalog();
            if (signal.aborted) {
              return {
                id: "chat-session-model",
                title: "Session model",
                searchPlaceholder: "Choose model",
                groups: [],
              };
            }
            const groups: CommandPageGroup[] = chooserProviders.map(
              (provider) => ({
                id: provider,
                label: getProviderLabel(provider),
                items: getCatalogModelsForProvider(provider, nextCatalog).map(
                  (model) => ({
                    id: `${provider}:${model.id}`,
                    title: model.label,
                    keywords: [model.id, getProviderLabel(provider)],
                    current:
                      activeProvider === provider && activeModel === model.id,
                    execute: () => onSessionModelSelection(provider, model.id),
                  }),
                ),
              }),
            );
            return {
              id: "chat-session-model",
              title: "Session model",
              searchPlaceholder: "Choose model or provider",
              groups,
            };
          } catch (error) {
            return {
              id: "chat-session-model",
              title: "Session model",
              searchPlaceholder: "Choose model",
              groups: [
                {
                  id: "error",
                  items: [
                    {
                      id: "catalog-error",
                      title: "Model catalog unavailable",
                      availability: {
                        state: "disabled",
                        reason:
                          error instanceof Error
                            ? error.message
                            : "Could not load the model catalog",
                      },
                      execute: () => undefined,
                    },
                  ],
                },
              ],
            };
          }
        },
      },
    ],
    [activeModel, activeProvider, chooserProviders, onSessionModelSelection],
  );
  useOptionalRegisterCommands(registerCommand ? modelCommands : EMPTY_COMMANDS);

  return (
    <ComposerModelPicker
      providers={providers}
      activeProvider={activeProvider}
      activeProviderLabel={getProviderLabel(activeProvider)}
      activeModel={activeModel}
      activeModelLabel={getModelLabelForProvider(
        activeProvider,
        activeModel,
        catalog,
      )}
      loading={loadingProviders.size > 0}
      onRetry={(provider) => void refresh(provider as RuntimeProvider, true)}
      onSelect={(provider, model) =>
        onSessionModelSelection(provider as RuntimeProvider, model)
      }
    />
  );
};
