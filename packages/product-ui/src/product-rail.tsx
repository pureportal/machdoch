import {
  Aperture,
  FolderKanban,
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
  | "ralph"
  | "projects";

export function ProductRail({
  settingsHref,
  inspectorOpen,
  activeView,
  mediaAvailable,
  schedulerAvailable,
  instructionsAvailable = false,
  ralphAvailable,
  projectsAvailable,
  onSelectView,
  onToggleInspector,
}: {
  settingsHref?: string | undefined;
  inspectorOpen: boolean;
  activeView: ProductView;
  mediaAvailable: boolean;
  schedulerAvailable: boolean;
  instructionsAvailable?: boolean;
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
  if (settingsHref)
    actions.push({
      id: "settings",
      label: "Settings",
      icon: Settings2,
      href: settingsHref,
    });
  return <ApplicationNavigation items={items} actions={actions} />;
}
