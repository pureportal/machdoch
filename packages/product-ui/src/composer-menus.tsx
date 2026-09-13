import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import {
  Check,
  ChevronDown,
  Folder,
  Layers3,
  type LucideIcon,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ProductCommandHandler } from "./product-runtime";

type ControlTone =
  | "neutral"
  | "teal"
  | "cyan"
  | "sky"
  | "amber"
  | "fuchsia"
  | "rose"
  | "violet";

export interface OptionMenuItem {
  value: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: ControlTone;
  disabled?: boolean;
}

function ComposerMenu({
  label,
  className,
  contentClassName,
  disabled,
  trigger,
  children,
}: {
  label: string;
  className: string;
  contentClassName: string;
  disabled: boolean;
  trigger: ReactElement;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const mount = useCallback((element: HTMLDivElement | null) => {
    setContainer(element?.closest<HTMLElement>(".machdoch-product") ?? null);
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <DropdownMenu.Root open={open && !disabled} onOpenChange={setOpen}>
      <div ref={mount} className={className}>
        <DropdownMenu.Trigger asChild disabled={disabled}>
          {trigger}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={container}>
          <DropdownMenu.Content
            className={contentClassName}
            aria-label={label}
            aria-labelledby={undefined}
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            loop
          >
            {children}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </div>
    </DropdownMenu.Root>
  );
}

export function OptionMenu({
  label,
  activeValue,
  activeLabel,
  activeIcon: ActiveIcon,
  activeTone,
  options,
  disabled,
  onSelect,
}: {
  label: string;
  activeValue: string;
  activeLabel: string;
  activeIcon: LucideIcon;
  activeTone: ControlTone;
  options: OptionMenuItem[];
  disabled: boolean;
  onSelect: (value: string) => void;
}): ReactElement {
  return (
    <ComposerMenu
      label={label}
      className="m-product-option-menu"
      contentClassName="m-product-option-popover"
      disabled={disabled}
      trigger={
        <button
          type="button"
          aria-label={`${label}: ${activeLabel}`}
          title={`${label}: ${activeLabel}`}
          data-tone={activeTone}
        >
          <ActiveIcon aria-hidden="true" />
        </button>
      }
    >
      <DropdownMenu.Label asChild>
        <strong>{label}</strong>
      </DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={activeValue} onValueChange={onSelect}>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <DropdownMenu.RadioItem
              key={option.value}
              value={option.value}
              disabled={disabled || option.disabled === true}
              asChild
            >
              <button
                type="button"
                data-active={option.value === activeValue}
                data-tone={option.tone}
                disabled={disabled || option.disabled}
                aria-label={`Choose ${option.label}`}
              >
                <span>
                  <Icon aria-hidden="true" />
                </span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <DropdownMenu.ItemIndicator>
                  <Check aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </button>
            </DropdownMenu.RadioItem>
          );
        })}
      </DropdownMenu.RadioGroup>
    </ComposerMenu>
  );
}

export function WorkspaceMenu({
  session,
  workspaces,
  disabled,
  onCommand,
}: {
  session: ProductSession;
  workspaces: ProductShell["workspaces"];
  disabled: boolean;
  onCommand: ProductCommandHandler;
}): ReactElement {
  const current = workspaces.find(
    (workspace) => workspace.root === session.workspace,
  );
  const label = current?.label ?? session.workspace ?? "No workspace";
  return (
    <ComposerMenu
      label="Workspace"
      className="m-product-menu"
      contentClassName="m-product-menu-popover"
      disabled={disabled}
      trigger={
        <button
          type="button"
          aria-label={`Workspace: ${label}`}
          title={session.workspace}
        >
          <Folder aria-hidden="true" />
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      }
    >
      <DropdownMenu.RadioGroup
        value={session.workspace ?? ""}
        onValueChange={(workspace) =>
          void onCommand(
            workspace
              ? {
                  kind: "set-session-workspace",
                  sessionId: session.id,
                  workspace,
                }
              : { kind: "clear-session-workspace", sessionId: session.id },
          )
        }
      >
        {workspaces.map((workspace) => (
          <DropdownMenu.RadioItem
            key={workspace.root}
            value={workspace.root}
            disabled={disabled}
            asChild
          >
            <button
              type="button"
              disabled={disabled}
              data-active={workspace.root === session.workspace}
              title={workspace.root}
            >
              <span>{workspace.label}</span>
              <small>{workspace.sessionCount}</small>
            </button>
          </DropdownMenu.RadioItem>
        ))}
        <DropdownMenu.RadioItem value="" disabled={disabled} asChild>
          <button
            type="button"
            disabled={disabled}
            data-active={!session.workspace}
          >
            No workspace
          </button>
        </DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup>
    </ComposerMenu>
  );
}

export function ContextPackMenu({
  sessionId,
  contextPacks,
  disabled,
  onCommand,
}: {
  sessionId: string;
  contextPacks: ProductShell["contextPacks"];
  disabled: boolean;
  onCommand: ProductCommandHandler;
}): ReactElement {
  return (
    <ComposerMenu
      label="Context packs"
      className="m-product-menu"
      contentClassName="m-product-menu-popover"
      disabled={disabled}
      trigger={
        <button type="button" aria-label="Context packs">
          <Layers3 aria-hidden="true" />
          <span>Packs</span>
          <ChevronDown aria-hidden="true" />
        </button>
      }
    >
      {contextPacks.length ? (
        contextPacks.map((pack) => (
          <DropdownMenu.CheckboxItem
            key={pack.id}
            checked={pack.matched}
            disabled={disabled || pack.matched}
            onSelect={() =>
              void onCommand({
                kind: "apply-context-pack",
                sessionId,
                contextPackId: pack.id,
              })
            }
            asChild
          >
            <button
              type="button"
              data-active={pack.matched}
              disabled={disabled || pack.matched}
            >
              <span>{pack.name}</span>
              {pack.scopeLabel ? <small>{pack.scopeLabel}</small> : null}
            </button>
          </DropdownMenu.CheckboxItem>
        ))
      ) : (
        <span className="m-product-menu-empty">No packs</span>
      )}
    </ComposerMenu>
  );
}
