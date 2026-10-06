import { Menu, TerminalSquare, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";

export type ApplicationActivity =
  | "idle"
  | "running"
  | "completed"
  | "running-and-completed";

export interface ApplicationNavigationItem {
  id: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  pressed?: boolean;
  activity?: ApplicationActivity | undefined;
  href?: string;
  onSelect?: () => void;
  shortcut?: { label: string; ariaKeyShortcuts: string } | null;
}

const activityLabels = {
  idle: "",
  running: "running",
  completed: "completed work",
  "running-and-completed": "running and has completed work",
} satisfies Record<ApplicationActivity, string>;

function ActivityIndicator({
  activity = "idle",
}: {
  activity?: ApplicationActivity | undefined;
}): React.ReactElement | null {
  return activity === "idle" ? null : (
    <span
      className="m-navigation-activity"
      data-activity={activity}
      aria-hidden="true"
    />
  );
}

export function ApplicationNavigation({
  items,
  actions = [],
  footer,
}: {
  items: readonly ApplicationNavigationItem[];
  actions?: readonly ApplicationNavigationItem[];
  footer?: ReactNode;
}): React.ReactElement {
  const entries = [...items, ...actions];
  const current = entries.find((item) => item.active);
  const renderItem = (item: ApplicationNavigationItem): React.ReactElement => {
    const activity = activityLabels[item.activity ?? "idle"];
    const name = activity ? `${item.label}, ${activity}` : item.label;
    const title = item.shortcut ? `${name} (${item.shortcut.label})` : name;
    const props = {
      className: "m-navigation-button",
      "aria-label": name,
      "aria-current": item.active ? ("page" as const) : undefined,
      "aria-pressed": item.pressed,
      "aria-keyshortcuts": item.shortcut?.ariaKeyShortcuts,
      "data-active": item.active === true || item.pressed === true,
      title,
    };
    const content = (
      <>
        <item.icon aria-hidden="true" />
        <ActivityIndicator activity={item.activity} />
      </>
    );
    return item.href ? (
      <a key={item.id} {...props} href={item.href}>
        {content}
      </a>
    ) : (
      <button key={item.id} {...props} type="button" onClick={item.onSelect}>
        {content}
      </button>
    );
  };

  return (
    <>
      <nav className="m-navigation-mobile" aria-label="App navigation">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className="m-navigation-trigger"
            aria-label="Open navigation"
          >
            <Menu aria-hidden="true" />
            <span>{current?.label ?? "Machdoch"}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="m-navigation-menu"
              align="start"
              sideOffset={4}
            >
              {entries.map((item) => (
                <DropdownMenu.Item key={item.id} asChild>
                  {item.href ? (
                    <a
                      href={item.href}
                      aria-current={item.active ? "page" : undefined}
                    >
                      <item.icon aria-hidden="true" />
                      {item.label}
                      <ActivityIndicator activity={item.activity} />
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={item.onSelect}
                      aria-current={item.active ? "page" : undefined}
                    >
                      <item.icon aria-hidden="true" />
                      {item.label}
                      <ActivityIndicator activity={item.activity} />
                    </button>
                  )}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </nav>
      <aside
        className="m-application-navigation"
        aria-label="Product navigation"
      >
        <div className="m-navigation-group">
          <div className="m-navigation-logo" aria-hidden="true">
            <TerminalSquare />
          </div>
          <div className="m-navigation-separator" />
          {items.map(renderItem)}
        </div>
        <div className="m-navigation-group">
          {actions.map(renderItem)}
          {footer}
        </div>
      </aside>
    </>
  );
}
