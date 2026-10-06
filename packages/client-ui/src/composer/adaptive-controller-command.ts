import type {
  CommandDefinition,
  CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

export const ADAPTIVE_CONTROLLER_OPTIONS = [
  { value: "default", label: "Default", override: null },
  { value: "enabled", label: "Enabled", override: true },
  { value: "disabled", label: "Disabled", override: false },
] as const;

export const createAdaptiveControllerCommand = (
  override: boolean | null,
  defaultEnabled: boolean | null,
  onChange: (override: boolean | null) => void,
  disabled = false,
): CommandDefinition => ({
  id: "chat.session.adaptive-controller.select",
  title: "Choose adaptive context & compute",
  group: "Chat",
  keywords: ["adaptive", "context", "compute"],
  scope: { kind: "view", ownerId: "chat" },
  palette: "visible",
  overlayPolicy: "replace-non-modal",
  availability: () =>
    disabled
      ? { state: "disabled", reason: "Wait for the current action to finish." }
      : { state: "enabled" },
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
