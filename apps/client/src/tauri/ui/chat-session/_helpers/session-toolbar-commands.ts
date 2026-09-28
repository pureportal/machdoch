import type { ParallelAgentMode } from "../../../../core/types.js";
import type {
  CommandDefinition,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

export const ADAPTIVE_CONTROLLER_OPTIONS = [
  { value: "default", label: "Default", override: null },
  { value: "enabled", label: "Enabled", override: true },
  { value: "disabled", label: "Disabled", override: false },
] as const;

export const PARALLEL_AGENT_OPTIONS: readonly {
  value: ParallelAgentMode;
  label: string;
}[] = [
  { value: "disabled", label: "Disabled" },
  { value: "read-only", label: "Read Only" },
  { value: "machdoch", label: "Full Mode" },
  { value: "native", label: "Native" },
];

export const createAdaptiveControllerCommand = (
  override: boolean | null,
  defaultEnabled: boolean | null,
  onChange: (override: boolean | null) => void,
): CommandDefinition => ({
  id: "chat.session.adaptive-controller.select",
  title: "Choose adaptive context & compute",
  group: "Chat",
  keywords: ["adaptive", "context", "compute"],
  scope: { kind: "view", ownerId: "chat" },
  palette: "visible",
  overlayPolicy: "replace-non-modal",
  children: () => ({
    id: "chat-session-adaptive-controller",
    title: "Adaptive context & compute",
    searchPlaceholder: "Choose adaptive context & compute",
    numericSelection: true,
    groups: [
      {
        id: "adaptive-controller",
        items: ADAPTIVE_CONTROLLER_OPTIONS.map(
          (option, index): CommandPageItem => ({
            id: option.value,
            title:
              option.override === null && defaultEnabled !== null
                ? `Default (${defaultEnabled ? "Enabled" : "Disabled"})`
                : option.label,
            current: override === option.override,
            numericKey: String(index + 1) as CommandPageItem["numericKey"],
            execute: () => onChange(option.override),
          }),
        ),
      },
    ],
  }),
});

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
