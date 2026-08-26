import { Slot } from "radix-ui";
import { type ComponentProps, type JSX, type KeyboardEvent } from "react";

const SUBMIT_SHORTCUT_SCOPE_SELECTOR = '[data-submit-shortcut-scope="true"]';
const SUBMIT_SHORTCUT_ACTION_SELECTOR = '[data-submit-shortcut-action="true"]';
const NON_EDITING_INPUT_TYPES = new Set([
  "button",
  "hidden",
  "image",
  "reset",
  "submit",
]);

export const SUBMIT_SHORTCUT_ACTION_PROPS = {
  "aria-keyshortcuts": "Control+Enter Meta+Enter",
  "data-submit-shortcut-action": "true",
} as const;

type SubmitShortcutAction = HTMLButtonElement | HTMLInputElement;

const isApplicableFormControl = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const control = target.closest<HTMLElement>("input, textarea, select");

  if (!control) {
    return target.isContentEditable;
  }

  if (control instanceof HTMLInputElement) {
    return (
      !control.disabled &&
      !control.readOnly &&
      !NON_EDITING_INPUT_TYPES.has(control.type)
    );
  }

  if (control instanceof HTMLTextAreaElement) {
    return !control.disabled && !control.readOnly;
  }

  return control instanceof HTMLSelectElement && !control.disabled;
};

const isSubmitShortcut = (event: KeyboardEvent<HTMLElement>): boolean => {
  return (
    (event.key === "Enter" || event.key === "Return") &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229 &&
    !event.getModifierState("AltGraph")
  );
};

const findSubmitAction = (scope: HTMLElement): SubmitShortcutAction | null => {
  const explicitAction = Array.from(
    scope.querySelectorAll<SubmitShortcutAction>(
      SUBMIT_SHORTCUT_ACTION_SELECTOR,
    ),
  ).find(
    (candidate) => candidate.closest(SUBMIT_SHORTCUT_SCOPE_SELECTOR) === scope,
  );

  if (explicitAction) {
    return explicitAction.disabled ? null : explicitAction;
  }
  return null;
};

const handleSubmitShortcutKeyDown = (
  event: KeyboardEvent<HTMLElement>,
  onSubmitShortcut?: (event: KeyboardEvent<HTMLElement>) => void,
): void => {
  if (
    event.defaultPrevented ||
    !isSubmitShortcut(event) ||
    !isApplicableFormControl(event.target)
  ) {
    return;
  }

  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    target.closest(SUBMIT_SHORTCUT_SCOPE_SELECTOR) !== event.currentTarget
  ) {
    return;
  }

  const action = onSubmitShortcut
    ? null
    : findSubmitAction(event.currentTarget);
  if (!onSubmitShortcut && !action) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (onSubmitShortcut) {
    onSubmitShortcut(event);
  } else {
    action?.click();
  }
};

type SubmitShortcutProps = ComponentProps<"div"> & {
  asChild?: boolean;
  onSubmitShortcut?: (event: KeyboardEvent<HTMLElement>) => void;
};

export const SubmitShortcut = ({
  asChild = false,
  onKeyDown,
  onSubmitShortcut,
  ...props
}: SubmitShortcutProps): JSX.Element => {
  const Component = asChild ? Slot.Root : "div";

  return (
    <Component
      {...props}
      aria-keyshortcuts={
        onSubmitShortcut
          ? SUBMIT_SHORTCUT_ACTION_PROPS["aria-keyshortcuts"]
          : props["aria-keyshortcuts"]
      }
      data-submit-shortcut-scope="true"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        handleSubmitShortcutKeyDown(event, onSubmitShortcut);
      }}
    />
  );
};
