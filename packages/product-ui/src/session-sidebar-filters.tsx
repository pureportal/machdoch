import type { SessionIndexQuery } from "@machdoch/fleet-protocol/session-data";
import {
  Archive,
  Ban,
  BellDot,
  Check,
  ChevronDown,
  CircleDashed,
  CircleSlash,
  CircleStop,
  ClockAlert,
  Inbox,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  ServerCrash,
  Tag,
  XCircle,
} from "lucide-react";
import { useRef } from "react";
import { DropdownMenu } from "radix-ui";
import type { SessionSidebarStatus } from "./session-sidebar-commands-state";

type SessionScope = SessionIndexQuery["scope"];
type SessionStatus = Exclude<SessionSidebarStatus, "any">;

export const sessionScopeFilters = [
  { id: "all", label: "All", icon: Inbox },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const;

export const sessionStatusFilters = [
  { id: "unread", label: "Unread", icon: BellDot },
  { id: "empty", label: "Empty", icon: CircleDashed },
  { id: "running", label: "Running", icon: LoaderCircle },
  { id: "done", label: "Done", icon: Check },
  { id: "failed", label: "Failed", icon: XCircle },
  { id: "blocked", label: "Blocked", icon: Ban },
  { id: "cancelled", label: "Cancelled", icon: CircleStop },
  { id: "timed-out", label: "Timed out", icon: ClockAlert },
  { id: "unsupported", label: "Unsupported", icon: CircleSlash },
  { id: "crashed", label: "Crashed", icon: ServerCrash },
] as const;

const menuContainer = (trigger: HTMLElement | null) =>
  trigger?.closest<HTMLElement>(".machdoch-product");

export function SessionFilterMenus({
  scope,
  statuses,
  availableStatuses,
  onScopeChange,
  onStatusToggle,
}: {
  scope: SessionScope;
  statuses: readonly SessionStatus[];
  availableStatuses: readonly (typeof sessionStatusFilters)[number][];
  onScopeChange: (scope: SessionScope) => void;
  onStatusToggle: (status: SessionSidebarStatus) => void;
}): React.ReactElement {
  const scopeTrigger = useRef<HTMLButtonElement>(null);
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const selectedScope =
    sessionScopeFilters.find((filter) => filter.id === scope) ??
    sessionScopeFilters[0];
  const singleStatus =
    statuses.length === 1
      ? sessionStatusFilters.find((filter) => filter.id === statuses[0])
      : undefined;
  const statusLabel =
    statuses.length === 0
      ? "Any status"
      : (singleStatus?.label ?? `${statuses.length} statuses`);
  const ScopeIcon = selectedScope.icon;
  const StatusIcon = singleStatus?.icon ?? ListFilter;
  return (
    <div className="m-product-session-filter-controls">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={scopeTrigger}
            type="button"
            className="m-product-session-filter-select"
            data-active={scope !== "all"}
            aria-label={`Session scope: ${selectedScope.label}`}
          >
            <ScopeIcon aria-hidden="true" />
            <span>{selectedScope.label}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={menuContainer(scopeTrigger.current)}>
          <DropdownMenu.Content
            className="m-product-session-menu"
            align="start"
            sideOffset={6}
            collisionPadding={8}
          >
            <DropdownMenu.RadioGroup
              value={scope}
              onValueChange={(value) => {
                const next = sessionScopeFilters.find(
                  (filter) => filter.id === value,
                );
                if (next) onScopeChange(next.id);
              }}
            >
              {sessionScopeFilters.map((filter) => {
                const Icon = filter.icon;
                return (
                  <DropdownMenu.RadioItem key={filter.id} value={filter.id}>
                    <Icon aria-hidden="true" />
                    {filter.label}
                    <DropdownMenu.ItemIndicator className="m-product-menu-indicator">
                      <Check aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={statusTrigger}
            type="button"
            className="m-product-session-filter-select"
            data-active={statuses.length > 0}
            aria-label={`Session status: ${statusLabel}`}
          >
            <StatusIcon aria-hidden="true" />
            <span>{statusLabel}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={menuContainer(statusTrigger.current)}>
          <DropdownMenu.Content
            className="m-product-session-menu"
            align="end"
            sideOffset={6}
            collisionPadding={8}
          >
            <DropdownMenu.CheckboxItem
              checked={statuses.length === 0}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => onStatusToggle("any")}
            >
              <ListFilter aria-hidden="true" />
              Any status
              <DropdownMenu.ItemIndicator className="m-product-menu-indicator">
                <Check aria-hidden="true" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
            {availableStatuses.map((filter) => {
              const Icon = filter.icon;
              return (
                <DropdownMenu.CheckboxItem
                  key={filter.id}
                  checked={statuses.includes(filter.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onStatusToggle(filter.id)}
                >
                  <Icon aria-hidden="true" />
                  {filter.label}
                  <DropdownMenu.ItemIndicator className="m-product-menu-indicator">
                    <Check aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

export function SessionTagFilters({
  tags,
  selected,
  onToggle,
}: {
  tags: readonly string[];
  selected: readonly string[];
  onToggle: (tag: string) => void;
}): React.ReactElement {
  return (
    <div className="m-product-session-tags">
      {tags.slice(0, 10).map((tag) => {
        const pressed = selected.some(
          (value) => value.toLowerCase() === tag.toLowerCase(),
        );
        return (
          <button
            key={tag}
            type="button"
            aria-label={`Tag: ${tag}`}
            aria-pressed={pressed}
            onClick={() => onToggle(tag)}
          >
            <Tag aria-hidden="true" />
            <span>{tag}</span>
          </button>
        );
      })}
    </div>
  );
}
