import type { ParallelAgentMode } from "../../../../core/types.js";
import type {
  CommandDefinition,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

export const PARALLEL_AGENT_OPTIONS: readonly {
  value: ParallelAgentMode;
  label: string;
}[] = [
  { value: "disabled", label: "Disabled" },
  { value: "read-only", label: "Read Only" },
  { value: "machdoch", label: "Full Mode" },
  { value: "native", label: "Native" },
];

export const createParallelAgentCommand = (
  mode: ParallelAgentMode,
  availableModes: readonly ParallelAgentMode[],
  onChange: (mode: ParallelAgentMode) => void,
): CommandDefinition => ({
  id: "chat.session.parallel-agents.select",
  title: "Choose parallel agents mode",
  group: "Chat",
  keywords: ["agents", "read only", "full mode", "native"],
  scope: { kind: "view", ownerId: "chat" },
  palette: "visible",
  overlayPolicy: "replace-non-modal",
  availability: () =>
    availableModes.length > 1
      ? { state: "enabled" }
      : { state: "disabled", reason: "Parallel agents unavailable" },
  children: () => ({
    id: "chat-session-parallel-agents",
    title: "Parallel agents",
    searchPlaceholder: "Choose parallel agents mode",
    numericSelection: true,
    groups: [
      {
        id: "parallel-agents",
        items: PARALLEL_AGENT_OPTIONS.filter((option) =>
          availableModes.includes(option.value),
        ).map(
          (option, index): CommandPageItem => ({
            id: option.value,
            title: option.label,
            current: mode === option.value,
            numericKey: String(index + 1) as CommandPageItem["numericKey"],
            execute: () => onChange(option.value),
          }),
        ),
      },
    ],
  }),
});
