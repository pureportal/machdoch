// @vitest-environment jsdom

import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverContent } from "../components/ui/popover";
import {
  CommandProvider,
  useCommandPageLauncher,
  useOptionalCommandShortcut,
  useOptionalRegisterCommands,
} from "./command-context";
import type {
  CommandContextSnapshot,
  CommandDefinition,
  CommandPage,
} from "./command-types";

beforeAll(() => {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

const renderProvider = (
  commands: readonly CommandDefinition[] = [],
  child: React.ReactNode = React.createElement("button", null, "Invoker"),
) =>
  render(
    React.createElement(CommandProvider, {
      activeView: "chat",
      platform: "windows",
      runtime: "browser",
      commands,
      children: child,
    }),
  );

const openPalette = (): void => {
  fireEvent.keyDown(document, {
    key: "k",
    code: "KeyK",
    ctrlKey: true,
  });
};

const visibleCommand = (
  id: string,
  title: string,
  execute: CommandDefinition["execute"],
): CommandDefinition => ({
  id,
  title,
  group: "Test",
  scope: { kind: "global", ownerId: "app" },
  palette: "visible",
  execute,
});

const CompactLauncher = ({
  page,
}: {
  page: CommandPage;
}): React.JSX.Element => {
  const openPage = useCommandPageLauncher();
  return React.createElement(
    "button",
    {
      onClick: (event: React.MouseEvent<HTMLButtonElement>) =>
        openPage(page, {
          presentation: "popover",
          anchor: event.currentTarget,
        }),
    },
    "Open compact page",
  );
};

const UnstableShortcutRegistrant = ({
  onExecute,
}: {
  onExecute: (version: number) => void;
}): React.JSX.Element => {
  const [alternate, setAlternate] = React.useState(false);
  const [callbackVersion, setCallbackVersion] = React.useState(0);
  useOptionalRegisterCommands([
    {
      id: "test.unstable-shortcut",
      title: "Unstable shortcut",
      group: "Test",
      scope: { kind: "view", ownerId: "chat" },
      shortcuts: [{ chord: alternate ? "Mod+Shift+S" : "Mod+S" }],
      palette: "visible",
      execute: () => onExecute(callbackVersion),
    },
  ]);
  const shortcut = useOptionalCommandShortcut("test.unstable-shortcut");

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "span",
      { "data-testid": "unstable-shortcut-hint" },
      shortcut?.label ?? "Missing",
    ),
    React.createElement(
      "button",
      { onClick: () => setCallbackVersion((version) => version + 1) },
      "Change callback",
    ),
    React.createElement(
      "button",
      { onClick: () => setAlternate(true) },
      "Change shortcut",
    ),
  );
};

const ShortcutNavigationHarness = ({
  onExecute,
}: {
  onExecute: (version: number) => void;
}): React.JSX.Element => {
  const [visible, setVisible] = React.useState(true);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      { onClick: () => setVisible(false) },
      "Leave command view",
    ),
    React.createElement(
      "button",
      { onClick: () => setVisible(true) },
      "Return to command view",
    ),
    visible
      ? React.createElement(UnstableShortcutRegistrant, { onExecute })
      : React.createElement("span", null, "Other view"),
  );
};

describe("CommandProvider and command palette", () => {
  it("keeps unstable command callbacks and shortcut hints live without looping", async () => {
    const execute = vi.fn();
    renderProvider(
      [],
      React.createElement(UnstableShortcutRegistrant, {
        onExecute: execute,
      }),
    );

    expect(
      (await screen.findByTestId("unstable-shortcut-hint")).textContent,
    ).toBe("Ctrl+S");

    fireEvent.click(screen.getByText("Change callback"));
    openPalette();
    await userEvent.setup().click(await screen.findByText("Unstable shortcut"));
    await waitFor(() => expect(execute).toHaveBeenLastCalledWith(1));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands…")).toBeNull(),
    );

    fireEvent.click(screen.getByText("Change shortcut"));
    await waitFor(() =>
      expect(screen.getByTestId("unstable-shortcut-hint").textContent).toBe(
        "Ctrl+Shift+S",
      ),
    );

    fireEvent.keyDown(document, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, {
      key: "S",
      code: "KeyS",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(execute).toHaveBeenLastCalledWith(1));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("cleans up and restores unstable registrations across view navigation", async () => {
    const execute = vi.fn();
    renderProvider(
      [],
      React.createElement(ShortcutNavigationHarness, { onExecute: execute }),
    );

    for (let visit = 0; visit < 2; visit += 1) {
      expect(
        (await screen.findByTestId("unstable-shortcut-hint")).textContent,
      ).toBe("Ctrl+S");
      fireEvent.click(screen.getByText("Leave command view"));
      expect(screen.queryByTestId("unstable-shortcut-hint")).toBeNull();
      fireEvent.keyDown(document, {
        key: "s",
        code: "KeyS",
        ctrlKey: true,
      });
      expect(execute).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("Return to command view"));
    }

    expect(
      (await screen.findByTestId("unstable-shortcut-hint")).textContent,
    ).toBe("Ctrl+S");
    fireEvent.keyDown(document, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
    });
    await waitFor(() => expect(execute).toHaveBeenCalledWith(0));
  });

  it("opens with Mod+K from ordinary text entry and toggles closed", async () => {
    renderProvider(
      [],
      React.createElement("input", { "aria-label": "Ordinary input" }),
    );
    screen.getByLabelText("Ordinary input").focus();
    openPalette();
    const paletteInput = await screen.findByPlaceholderText("Search commands…");
    fireEvent.keyDown(paletteInput, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands…")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Ordinary input"),
      ),
    );
  });

  it("does not steal Mod+K from editor boundaries, composition, or repeats", () => {
    renderProvider(
      [],
      React.createElement("div", {
        tabIndex: 0,
        "aria-label": "Editor",
        "data-command-focus": "editor",
      }),
    );
    const editor = screen.getByLabelText("Editor");
    editor.focus();
    fireEvent.keyDown(editor, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    fireEvent.keyDown(document, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(document, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      repeat: true,
    });
    expect(screen.queryByPlaceholderText("Search commands…")).toBeNull();
  });

  it("filters, executes, and closes after a successful action", async () => {
    const execute = vi.fn();
    const user = userEvent.setup();
    renderProvider([
      visibleCommand("test.run", "Run special task", execute),
      visibleCommand("test.stop", "Stop task", vi.fn()),
    ]);
    openPalette();
    const input = (await screen.findByPlaceholderText(
      "Search commands…",
    )) as HTMLInputElement;
    await user.type(input, "special");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: "Home", code: "Home" });
    expect(input.selectionStart).toBe(0);
    expect(screen.queryByText("Stop task")).toBeNull();
    await user.click(screen.getByText("Run special task"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText("Run special task")).toBeNull(),
    );
  });

  it("keeps the current palette state when an action is cancelled", async () => {
    const user = userEvent.setup();
    renderProvider([
      visibleCommand("test.cancel", "Cancel action", () => ({
        type: "cancelled",
      })),
    ]);
    openPalette();
    await user.click(await screen.findByText("Cancel action"));
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy();
  });

  it("keeps disabled commands inert and exposes the recovery reason", async () => {
    const execute = vi.fn();
    const user = userEvent.setup();
    renderProvider([
      {
        ...visibleCommand("test.disabled", "Unavailable action", execute),
        availability: () => ({
          state: "disabled",
          reason: "Select a flow first",
        }),
      },
    ]);
    openPalette();
    const row = await screen.findByTitle("Select a flow first");
    await user.click(row);
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy();
  });

  it("supports nested pages, Backspace/Escape navigation, and numeric selection", async () => {
    const choose = vi.fn();
    const page: CommandPage = {
      id: "target",
      title: "Choose target",
      searchPlaceholder: "Search targets",
      numericSelection: true,
      groups: [
        {
          id: "targets",
          items: [
            {
              id: "second",
              title: "Second target",
              numericKey: "2",
              execute: choose,
            },
          ],
        },
      ],
    };
    renderProvider([
      {
        id: "test.choose",
        title: "Choose a target",
        group: "Test",
        scope: { kind: "global", ownerId: "app" },
        palette: "visible",
        children: () => page,
      },
    ]);
    const user = userEvent.setup();
    openPalette();
    const rootInput = await screen.findByPlaceholderText("Search commands…");
    await user.type(rootInput, "choose");
    await user.click(await screen.findByText("Choose a target"));
    const nestedInput = await screen.findByPlaceholderText("Search targets");
    fireEvent.keyDown(nestedInput, { key: "Escape" });
    expect(
      (await screen.findByPlaceholderText(
        "Search commands…",
      )) as HTMLInputElement,
    ).toMatchObject({ value: "choose" });

    await user.click(screen.getByText("Choose a target"));
    const numericInput = await screen.findByPlaceholderText("Search targets");
    fireEvent.keyDown(numericInput, {
      key: "Backspace",
      code: "Backspace",
      isComposing: true,
    });
    expect(screen.getByPlaceholderText("Search targets")).toBeTruthy();
    fireEvent.keyDown(numericInput, {
      key: "2",
      code: "Digit2",
      repeat: true,
    });
    expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(numericInput, {
      key: "@",
      code: "Digit2",
      shiftKey: true,
    });
    expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(numericInput, {
      key: "2",
      code: "Digit2",
      shiftKey: true,
    });
    await waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
  });

  it("renders a shared page in the compact anchored presentation", async () => {
    const page: CommandPage = {
      id: "compact",
      title: "Compact targets",
      searchPlaceholder: "Search compact targets",
      groups: [],
    };
    const user = userEvent.setup();
    renderProvider([], React.createElement(CompactLauncher, { page }));
    await user.click(screen.getByText("Open compact page"));
    const input = await screen.findByPlaceholderText("Search compact targets");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("blocks the application palette behind an unrelated modal", () => {
    renderProvider(
      [],
      React.createElement(
        Dialog,
        { open: true },
        React.createElement(
          DialogContent,
          null,
          React.createElement(DialogTitle, null, "Blocking dialog"),
        ),
      ),
    );
    openPalette();
    expect(screen.queryByPlaceholderText("Search commands…")).toBeNull();
    expect(screen.getByText("Blocking dialog")).toBeTruthy();
  });

  it("shows only commands owned by a command-aware modal", async () => {
    const executeOverlay = vi.fn();
    const commands: readonly CommandDefinition[] = [
      {
        id: "chat.behind-modal",
        title: "Behind modal",
        group: "Test",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        execute: vi.fn(),
      },
      {
        id: "global.behind-modal",
        title: "Global behind modal",
        group: "Test",
        scope: { kind: "global", ownerId: "app" },
        palette: "visible",
        execute: vi.fn(),
      },
      {
        id: "modal.owned",
        title: "Modal action",
        group: "Test",
        scope: { kind: "overlay", ownerId: "command-aware-modal" },
        palette: "visible",
        execute: executeOverlay,
      },
    ];
    renderProvider(
      commands,
      React.createElement(
        Dialog,
        {
          open: true,
          commandOverlayId: "command-aware-modal",
          commandOverlayAllowGlobalCommands: ["app.palette.toggle"],
        },
        React.createElement(
          DialogContent,
          null,
          React.createElement(DialogTitle, null, "Command-aware dialog"),
        ),
      ),
    );

    openPalette();
    expect(await screen.findByText("Modal action")).toBeTruthy();
    expect(screen.queryByText("Behind modal")).toBeNull();
    expect(screen.queryByText("Global behind modal")).toBeNull();
    await userEvent.setup().click(screen.getByText("Modal action"));
    await waitFor(() => expect(executeOverlay).toHaveBeenCalledTimes(1));
  });

  it("dismisses a replaceable non-modal surface before opening", async () => {
    const onOpenChange = vi.fn();
    renderProvider(
      [],
      React.createElement(
        Popover,
        { open: true, onOpenChange },
        React.createElement(PopoverContent, null, "Open popover"),
      ),
    );
    openPalette();
    expect(await screen.findByPlaceholderText("Search commands…")).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes the palette when the active view changes", async () => {
    const child = React.createElement("button", null, "Invoker");
    const result = render(
      React.createElement(CommandProvider, {
        activeView: "chat",
        platform: "windows",
        runtime: "browser",
        children: child,
      }),
    );
    openPalette();
    await screen.findByPlaceholderText("Search commands…");
    result.rerender(
      React.createElement(CommandProvider, {
        activeView: "media",
        platform: "windows",
        runtime: "browser",
        children: child,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands…")).toBeNull(),
    );
  });

  it("has no automated accessibility violations in the root dialog", async () => {
    renderProvider([
      visibleCommand("test.accessible", "Accessible action", vi.fn()),
    ]);
    openPalette();
    await screen.findByPlaceholderText("Search commands…");
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("locks duplicate async shortcut execution", async () => {
    let resolveAction: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const execute = vi.fn(() => pending);
    renderProvider([
      {
        ...visibleCommand("test.async", "Async action", execute),
        palette: "hidden",
        shortcuts: [{ chord: "Mod+J" }],
      },
    ]);
    for (let index = 0; index < 2; index += 1) {
      fireEvent.keyDown(document, {
        key: "j",
        code: "KeyJ",
        ctrlKey: true,
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
    resolveAction?.();
    await pending;
  });

  it("preserves entity ownership through direct shortcut execution", async () => {
    const execute = vi.fn((context: CommandContextSnapshot) => {
      expect(context.focus.ownerPath).toContain("canvas-selection");
    });
    renderProvider(
      [
        {
          id: "test.entity",
          title: "Entity action",
          group: "Test",
          scope: { kind: "entity", ownerId: "canvas-selection" },
          shortcuts: [{ chord: "Mod+J" }],
          palette: "visible",
          execute,
        },
      ],
      React.createElement("div", {
        tabIndex: 0,
        "aria-label": "Canvas selection",
        "data-command-owner": "canvas-selection",
      }),
    );
    const canvas = screen.getByLabelText("Canvas selection");
    canvas.focus();
    fireEvent.keyDown(canvas, {
      key: "j",
      code: "KeyJ",
      ctrlKey: true,
    });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(canvas, {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByText("Entity action"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  it("preserves invocation ownership through a directly opened child page", async () => {
    const chooseTarget = vi.fn((context: CommandContextSnapshot) => {
      expect(context.focus.ownerPath).toContain("canvas-selection");
    });
    const openPage = vi.fn((context: CommandContextSnapshot) => {
      expect(context.focus.ownerPath).toContain("canvas-selection");
      return {
        id: "entity-targets",
        title: "Entity targets",
        searchPlaceholder: "Search entity targets",
        groups: [
          {
            id: "targets",
            items: [
              {
                id: "target",
                title: "Entity target",
                execute: chooseTarget,
              },
            ],
          },
        ],
      } satisfies CommandPage;
    });
    renderProvider(
      [
        {
          id: "test.entity-page",
          title: "Open entity targets",
          group: "Test",
          scope: { kind: "entity", ownerId: "canvas-selection" },
          shortcuts: [{ chord: "Mod+J" }],
          palette: "visible",
          children: openPage,
        },
      ],
      React.createElement("div", {
        tabIndex: 0,
        "aria-label": "Canvas selection",
        "data-command-owner": "canvas-selection",
      }),
    );
    const canvas = screen.getByLabelText("Canvas selection");
    canvas.focus();
    fireEvent.keyDown(canvas, {
      key: "j",
      code: "KeyJ",
      ctrlKey: true,
    });
    await screen.findByPlaceholderText("Search entity targets");
    expect(openPage).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByText("Entity target"));
    await waitFor(() => expect(chooseTarget).toHaveBeenCalledTimes(1));
  });

  it("revalidates availability immediately before execution", async () => {
    let available = true;
    const execute = vi.fn();
    const user = userEvent.setup();
    renderProvider([
      {
        ...visibleCommand("test.fresh", "Fresh action", execute),
        availability: () =>
          available
            ? { state: "enabled" }
            : { state: "disabled", reason: "No longer available" },
      },
    ]);
    openPalette();
    const row = await screen.findByText("Fresh action");
    available = false;
    await user.click(row);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await screen.findAllByText("No longer available")).length,
    ).toBeGreaterThan(0);
  });

  it("aborts and ignores a child page that resolves after the palette closes", async () => {
    let resolvePage: ((page: CommandPage) => void) | undefined;
    let actionSignal: AbortSignal | undefined;
    const pendingPage = new Promise<CommandPage>((resolve) => {
      resolvePage = resolve;
    });
    renderProvider([
      {
        id: "test.slow-page",
        title: "Load targets",
        group: "Test",
        scope: { kind: "global", ownerId: "app" },
        palette: "visible",
        children: (_context, signal) => {
          actionSignal = signal;
          return pendingPage;
        },
      },
    ]);
    const user = userEvent.setup();
    openPalette();
    await user.click(await screen.findByText("Load targets"));
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands…")).toBeNull(),
    );
    expect(actionSignal?.aborted).toBe(true);
    resolvePage?.({
      id: "late",
      title: "Late page",
      searchPlaceholder: "Search late targets",
      groups: [],
    });
    await pendingPage;
    expect(screen.queryByPlaceholderText("Search late targets")).toBeNull();
  });

  it("does not let an aborted action close a newly reopened palette", async () => {
    let resolveAction: (() => void) | undefined;
    const pendingAction = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    renderProvider([
      visibleCommand(
        "test.slow-action",
        "Run slow action",
        () => pendingAction,
      ),
    ]);
    const user = userEvent.setup();
    openPalette();
    await user.click(await screen.findByText("Run slow action"));
    openPalette();
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands…")).toBeNull(),
    );
    openPalette();
    await screen.findByPlaceholderText("Search commands…");
    resolveAction?.();
    await pendingAction;
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy();
  });
});
