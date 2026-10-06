import {
  Aperture,
  FolderKanban,
  FolderGit2,
  CalendarClock,
  BookOpenText,
  MessageSquareText,
  PanelRight,
  Settings2,
  Workflow,
} from "lucide-react";
import {
  ApplicationNavigation,
  type ApplicationNavigationItem,
} from "./application-navigation";

export type ProductView =
  | "chat"
  | "media"
  | "scheduler"
  | "instructions"
  | "workspaces"
  | "ralph"
  | "projects";

export function ProductRail({
  settingsAvailable,
  onOpenSettings,
  inspectorOpen,
  activeView,
  mediaAvailable,
  schedulerAvailable,
  instructionsAvailable = false,
  workspaceAvailable = false,
  ralphAvailable,
  projectsAvailable,
  onSelectView,
  onToggleInspector,
}: {
  settingsAvailable: boolean;
  onOpenSettings: () => void;
  inspectorOpen: boolean;
  activeView: ProductView;
  mediaAvailable: boolean;
  schedulerAvailable: boolean;
  instructionsAvailable?: boolean;
  workspaceAvailable?: boolean;
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
    { id: "chat", label: "Chat", icon: MessageSquareText, available: true },
    { id: "ralph", label: "RALPH", icon: Workflow, available: ralphAvailable },
    {
      id: "media",
      label: "Media Studio",
      icon: Aperture,
      available: mediaAvailable,
    },
    {
      id: "scheduler",
      label: "Smart Scheduler",
      icon: CalendarClock,
      available: schedulerAvailable,
    },
    {
      id: "instructions",
      label: "Instructions",
      icon: BookOpenText,
      available: instructionsAvailable,
    },
    {
      id: "workspaces",
      label: "Workspace Management",
      icon: FolderGit2,
      available: workspaceAvailable,
    },
  ] as const;
  const items: ApplicationNavigationItem[] = views
    .filter((view) => view.available)
    .map((view) => ({
      ...view,
      active: view.id === activeView,
      onSelect: () => onSelectView(view.id),
    }));
  const actions: ApplicationNavigationItem[] = [
    {
      id: "activity",
      label: "Activity",
      icon: PanelRight,
      pressed: inspectorOpen,
      onSelect: onToggleInspector,
    },
  ];
  if (settingsAvailable)
    actions.push({
      id: "settings",
      label: "Settings",
      icon: Settings2,
      onSelect: onOpenSettings,
    });
  return <ApplicationNavigation items={items} actions={actions} />;
}
