import {
  appControl,
  type AppControlAction,
} from "@machdoch/media-studio/tauri/ui/app-control/app-control-registry.js";
import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../chat-session/_helpers/session-shell";
import type { MainAppId } from "../lib/shell-store";

export const MAIN_APP_LABELS: Readonly<Record<MainAppId, string>> = {
  chat: "Chat",
  ralph: "RALPH",
  media: "Media Studio",
  tts: "Text to Speech",
  instructions: "Instructions",
  workspaces: "Workspace Management",
};

const MAIN_APP_IDS = Object.keys(MAIN_APP_LABELS) as MainAppId[];
const VIEW_READY_TIMEOUT_MS = 15_000;

export interface AppShellControlOptions {
  activeApp: MainAppId;
  unsavedChangesMessage: string | null;
  settingsSection: SettingsSection | null;
  schedulerOpen: boolean;
  onSelectApp: (app: MainAppId) => void;
  onOpenSettings: (section: SettingsSection) => void;
  onOpenScheduler: () => void;
}

export function useAppShellControl({
  activeApp,
  unsavedChangesMessage,
  settingsSection,
  schedulerOpen,
  onSelectApp,
  onOpenSettings,
  onOpenScheduler,
}: AppShellControlOptions): void {
  const actions: AppControlAction[] = [
    {
      id: "app.open_view",
      description:
        "Open a Machdoch view and wait until it is ready: chat, ralph (flows), media (Media Studio), tts (Text to Speech), instructions, workspaces (Workspace Management).",
      effect: "write",
      input: {
        type: "object",
        properties: { view: { type: "string", enum: MAIN_APP_IDS } },
        required: ["view"],
      },
      run: async (input, { signal }) => {
        const view = input.view as MainAppId;
        if (view !== activeApp && unsavedChangesMessage) {
          throw new Error(
            `${unsavedChangesMessage} The user has unsaved changes; ask them to save or discard first.`,
          );
        }
        onSelectApp(view);
        await appControl.waitForView(view, VIEW_READY_TIMEOUT_MS, signal);
        return { view: MAIN_APP_LABELS[view] };
      },
    },
    {
      id: "app.open_settings",
      description: "Open Machdoch Settings at a section.",
      effect: "write",
      input: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: SETTINGS_SECTIONS.map((section) => section.id),
          },
        },
        required: ["section"],
      },
      run: (input) => {
        const section = input.section as SettingsSection;
        onOpenSettings(section);
        return {
          section: SETTINGS_SECTIONS.find(({ id }) => id === section)?.label,
        };
      },
    },
    {
      id: "app.open_scheduler",
      description: "Open the Smart Scheduler for scheduled prompts and jobs.",
      effect: "write",
      input: { type: "object", properties: {} },
      run: () => {
        onOpenScheduler();
        return { opened: true };
      },
    },
  ];

  useAppControlView("app", APP_CONTROL_LEVEL.app, {
    location: [MAIN_APP_LABELS[activeApp]],
    state: () => ({
      activeView: activeApp,
      ...(settingsSection
        ? {
            openSettings: SETTINGS_SECTIONS.find(
              ({ id }) => id === settingsSection,
            )?.label,
          }
        : {}),
      ...(schedulerOpen ? { schedulerOpen } : {}),
      ...(unsavedChangesMessage ? { unsavedChanges: true } : {}),
    }),
    actions,
  });
}
