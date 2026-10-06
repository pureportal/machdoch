import {
  Aperture,
  CalendarClock,
  Cog,
  FileSliders,
  FolderGit2,
  MessageSquareText,
  Server,
  Workflow,
} from "lucide-react";
import {
  ApplicationNavigation,
  type ApplicationActivity,
  type ApplicationNavigationItem,
} from "@machdoch/product-ui";
import { useCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type { MainAppId } from "../lib/shell-store";

declare const __MACHDOCH_VERSION__: string | undefined;

export type AppActivityState = ApplicationActivity;

interface AppRailProps {
  activeApp: MainAppId;
  chatActivity: AppActivityState;
  ralphActivity: AppActivityState;
  mediaActivity: AppActivityState;
  schedulerActivity: AppActivityState;
  onSelectApp: (app: MainAppId) => void;
  onOpenScheduler: () => void;
  onOpenFleetManager: () => void;
  onOpenSettings: () => void;
}

export function AppRail({
  activeApp,
  chatActivity,
  ralphActivity,
  mediaActivity,
  schedulerActivity,
  onSelectApp,
  onOpenScheduler,
  onOpenFleetManager,
  onOpenSettings,
}: AppRailProps): React.ReactElement {
  const chatShortcut = useCommandShortcut("app.view.chat");
  const ralphShortcut = useCommandShortcut("app.view.ralph");
  const mediaShortcut = useCommandShortcut("app.view.media");
  const instructionsShortcut = useCommandShortcut("app.view.instructions");
  const workspacesShortcut = useCommandShortcut("app.view.workspaces");
  const settingsShortcut = useCommandShortcut("app.settings.open");
  const items: ApplicationNavigationItem[] = [
    {
      id: "chat",
      label: "Chat",
      icon: MessageSquareText,
      activity: chatActivity,
      shortcut: chatShortcut,
      active: activeApp === "chat",
      onSelect: () => onSelectApp("chat"),
    },
    {
      id: "ralph",
      label: "RALPH",
      icon: Workflow,
      activity: ralphActivity,
      shortcut: ralphShortcut,
      active: activeApp === "ralph",
      onSelect: () => onSelectApp("ralph"),
    },
    {
      id: "media",
      label: "Media Studio",
      icon: Aperture,
      activity: mediaActivity,
      shortcut: mediaShortcut,
      active: activeApp === "media",
      onSelect: () => onSelectApp("media"),
    },
    {
      id: "instructions",
      label: "Instructions",
      icon: FileSliders,
      shortcut: instructionsShortcut,
      active: activeApp === "instructions",
      onSelect: () => onSelectApp("instructions"),
    },
    {
      id: "workspaces",
      label: "Workspace Management",
      icon: FolderGit2,
      shortcut: workspacesShortcut,
      active: activeApp === "workspaces",
      onSelect: () => onSelectApp("workspaces"),
    },
  ];
  const actions: ApplicationNavigationItem[] = [
    {
      id: "scheduler",
      label: "Smart Scheduler",
      icon: CalendarClock,
      activity: schedulerActivity,
      onSelect: onOpenScheduler,
    },
    {
      id: "fleet",
      label: "Fleet Manager",
      icon: Server,
      onSelect: onOpenFleetManager,
    },
    {
      id: "settings",
      label: "Settings",
      icon: Cog,
      shortcut: settingsShortcut,
      onSelect: onOpenSettings,
    },
  ];
  const version =
    typeof __MACHDOCH_VERSION__ === "string" ? __MACHDOCH_VERSION__ : null;
  return (
    <ApplicationNavigation
      items={items}
      actions={actions}
      footer={
        version ? (
          <span className="app-shell-version">v{version}</span>
        ) : undefined
      }
    />
  );
}
