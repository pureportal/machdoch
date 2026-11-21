import {
  Aperture,
  AudioLines,
  FolderKanban,
  FolderGit2,
  CalendarClock,
  BookOpenText,
  MessageSquareText,
  Network,
  PanelRight,
  Settings2,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import {
  ApplicationNavigation,
  type ApplicationActivity,
  type ApplicationNavigationItem,
} from "./application-navigation";

export type ProductView =
  | "chat"
  | "media"
  | "tts"
  | "scheduler"
  | "instructions"
  | "mcp"
  | "workspaces"
  | "ralph"
  | "projects"
  | "services";

export function ProductRail({
  settingsAvailable,
  onOpenSettings,
  inspectorOpen,
  activeView,
  chatActivity = "idle",
  mediaAvailable,
  speechAvailable = false,
  schedulerAvailable,
  instructionsAvailable = false,
  mcpAvailable = false,
  workspaceAvailable = false,
  servicesAvailable = false,
  ralphAvailable,
  projectsAvailable,
  onSelectView,
  onToggleInspector,
}: {
  settingsAvailable: boolean;
  onOpenSettings: () => void;
  inspectorOpen: boolean;
  activeView: ProductView;
  chatActivity?: ApplicationActivity;
  mediaAvailable: boolean;
  speechAvailable?: boolean;
  schedulerAvailable: boolean;
  instructionsAvailable?: boolean;
  mcpAvailable?: boolean;
  workspaceAvailable?: boolean;
  servicesAvailable?: boolean;
  ralphAvailable: boolean;
  projectsAvailable: boolean;
  onSelectView: (view: ProductView) => void;
  onToggleInspector: () => void;
}): React.ReactElement {
  const views = [
    {
      id: "projects",
      label: "Projects",
      icon: FolderKanban,
      available: projectsAvailable,
    },
    {
      id: "chat",
      label: "Chat",
      icon: MessageSquareText,
      available: true,
      activity: chatActivity,
    },
    { id: "ralph", label: "RALPH", icon: Workflow, available: ralphAvailable },
    {
      id: "media",
      label: "Media Studio",
      icon: Aperture,
      available: mediaAvailable,
    },
    {
      id: "tts",
      label: "Text to Speech",
      icon: AudioLines,
      available: speechAvailable,
    },
    {
      id: "instructions",
      label: "Instructions",
      icon: BookOpenText,
      group: "management",
      available: instructionsAvailable,
    },
    {
      id: "mcp",
      label: "MCP servers",
      icon: Network,
      group: "management",
      available: mcpAvailable,
    },
    {
      id: "workspaces",
      label: "Workspace Management",
      icon: FolderGit2,
      group: "management",
      available: workspaceAvailable,
    },
    {
      id: "services",
      label: "Services & previews",
      icon: TerminalSquare,
      group: "management",
      available: servicesAvailable,
    },
  ] as const;
  const items: ApplicationNavigationItem[] = views
    .filter((view) => view.available)
    .map((view) => ({
      ...view,
      active: view.id === activeView,
      onSelect: () => onSelectView(view.id),
    }));
  const actions: ApplicationNavigationItem[] = [];
  if (schedulerAvailable)
    actions.push({
      id: "scheduler",
      label: "Smart Scheduler",
      icon: CalendarClock,
      active: activeView === "scheduler",
      onSelect: () => onSelectView("scheduler"),
    });
  actions.push({
    id: "activity",
    label: "Activity",
    icon: PanelRight,
    pressed: inspectorOpen,
    onSelect: onToggleInspector,
  });
  if (settingsAvailable)
    actions.push({
      id: "settings",
      label: "Settings",
      icon: Settings2,
      onSelect: onOpenSettings,
    });
  return <ApplicationNavigation items={items} actions={actions} />;
}
