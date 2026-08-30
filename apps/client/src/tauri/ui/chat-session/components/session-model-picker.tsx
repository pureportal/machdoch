import {
  ComposerModelPicker,
  type ComposerModelProvider,
} from "@machdoch/product-ui";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import type {
  CommandDefinition,
  CommandPage,
  CommandPageGroup,
} from "../../commands/command-types";
import {
  getCatalogModelsForProvider,
  getModelLabelForProvider,
  getProviderLabel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../../model-catalog";
import { loadProviderModelCatalog } from "../../runtime";

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
  const [open, setOpen] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalog, setCatalog] = useState<ProviderModelCatalogSnapshot | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setCatalogLoading(true);
    void loadProviderModelCatalog()
      .then((nextCatalog) => {
        if (!cancelled) setCatalog(nextCatalog);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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
          ...(runtimeProvider?.error ? { error: runtimeProvider.error } : {}),
          models: getCatalogModelsForProvider(provider, catalog).map(
            (model) => ({ id: model.id, label: model.label }),
          ),
        };
      }),
    [catalog, chooserProviders],
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
      loading={catalogLoading}
      onOpenChange={setOpen}
      onSelect={(provider, model) =>
        onSessionModelSelection(provider as RuntimeProvider, model)
      }
    />
  );
};
