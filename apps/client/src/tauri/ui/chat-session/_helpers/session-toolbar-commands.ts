import type { ParallelAgentMode } from "@machdoch/model-runtime/types";
import { getParallelAgentOptions } from "@machdoch/product-ui";
import type {
  CommandDefinition,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

export const createParallelAgentCommand = (
  mode: ParallelAgentMode,
  availableModes: readonly ParallelAgentMode[],
  onChange: (mode: ParallelAgentMode) => void,
  specialKind?: string,
): CommandDefinition => {
  const options = getParallelAgentOptions(availableModes, specialKind);
  const available = options.some(
    (option) => option.value !== "disabled" && !option.disabledReason,
  );
  return {
    id: "chat.session.parallel-agents.select",
    title: "Choose parallel agents mode",
    group: "Chat",
    keywords: ["agents", "read only", "full mode", "native"],
    scope: { kind: "view", ownerId: "chat" },
    palette: "visible",
    overlayPolicy: "replace-non-modal",
    availability: () =>
      available
        ? { state: "enabled" }
        : {
            state: "disabled",
            reason:
              specialKind === "pose"
                ? "Unavailable in Pose chats."
                : "Unavailable for this provider and model.",
          },
    children: () => ({
      id: "chat-session-parallel-agents",
      title: "Parallel agents",
      searchPlaceholder: "Choose parallel agents mode",
      numericSelection: true,
      groups: [
        {
          id: "parallel-agents",
          items: options.map(
            (option, index): CommandPageItem => ({
              id: option.value,
              title: option.label,
              current: mode === option.value,
              availability: option.disabledReason
                ? { state: "disabled", reason: option.disabledReason }
                : { state: "enabled" },
              numericKey: String(index + 1) as CommandPageItem["numericKey"],
              execute: () => {
                if (!option.disabledReason) onChange(option.value);
              },
            }),
          ),
        },
      ],
    }),
  };
};
