import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "./command-types";
import { createShortcutContext, resolveShortcut } from "./shortcut-resolver";

const event = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "k",
  code: "KeyK",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  getModifierState: () => false,
  ...overrides,
});

const command = (
  id: string,
  scope: CommandDefinition["scope"],
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title: id,
  group: "Test",
  scope,
  shortcuts: [{ chord: "Mod+K" }],
  ...extra,
});

describe("shortcut resolution", () => {
  it("prefers an eligible view command over a global command", () => {
    const resolution = resolveShortcut(
      event(),
      [
        command("global", { kind: "global", ownerId: "app" }),
        command("view", { kind: "view", ownerId: "media" }),
      ],
      createShortcutContext({
        platform: "windows",
        runtime: "tauri",
        activeView: "media",
      }),
    );
    expect(resolution.type).toBe("command");
    if (resolution.type === "command")
      expect(resolution.command.id).toBe("view");
  });

  it("uses scope precedence and the deepest focused owner", () => {
    const commands = [
      command("global", { kind: "global", ownerId: "app" }),
      command("view", { kind: "view", ownerId: "media" }),
      command("entity", { kind: "entity", ownerId: "selection" }),
      command("outer", { kind: "component", ownerId: "outer" }),
      command("inner", { kind: "component", ownerId: "inner" }),
      command("overlay", { kind: "overlay", ownerId: "menu" }),
    ];
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      activeView: "media",
      focus: {
        kind: "document",
        ownerPath: ["inner", "outer", "selection"],
      },
    });
    const focused = resolveShortcut(event(), commands, context);
    expect(focused.type === "command" && focused.command.id).toBe("inner");

    const withOverlay = resolveShortcut(event(), commands, {
      ...context,
      overlays: [
        {
          id: "menu",
          kind: "non-modal",
          openedAt: 1,
          allowGlobalCommands: [],
        },
      ],
    });
    expect(withOverlay.type === "command" && withOverlay.command.id).toBe(
      "overlay",
    );
  });

  it("reports same-precedence collisions and executes neither", () => {
    const resolution = resolveShortcut(
      event(),
      [
        command("a", { kind: "global", ownerId: "app" }),
        command("b", { kind: "global", ownerId: "app" }),
      ],
      createShortcutContext({ platform: "windows", runtime: "tauri" }),
    );
    expect(resolution).toEqual({
      type: "conflict",
      commandIds: ["a", "b"],
      preventDefault: false,
    });
  });

  it("honors a valid override and fails closed for an override cycle", () => {
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
    });
    const base = command("base", { kind: "global", ownerId: "app" });
    const override = command(
      "override",
      { kind: "global", ownerId: "app" },
      {
        overrideOf: "base",
      },
    );
    const valid = resolveShortcut(event(), [base, override], context);
    expect(valid.type === "command" && valid.command.id).toBe("override");

    const cycle = resolveShortcut(
      event(),
      [{ ...base, overrideOf: "override" }, override],
      context,
    );
    expect(cycle.type).toBe("conflict");
  });

  it("blocks lower scopes behind modal and non-modal overlays", () => {
    const base = command("base", { kind: "global", ownerId: "app" });
    const modal = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      overlays: [
        {
          id: "dialog",
          kind: "modal",
          openedAt: 1,
          allowGlobalCommands: [],
        },
      ],
    });
    expect(resolveShortcut(event(), [base], modal).type).toBe("none");

    const nonModal = {
      ...modal,
      overlays: [{ ...modal.overlays[0]!, kind: "non-modal" as const }],
    };
    expect(resolveShortcut(event(), [base], nonModal).type).toBe("none");
    const replace = { ...base, overlayPolicy: "replace-non-modal" as const };
    expect(resolveShortcut(event(), [replace], nonModal).type).toBe("command");
  });

  it("allows an explicit modal command and blocks disabled defaults", () => {
    const allowed = command(
      "allowed",
      { kind: "global", ownerId: "app" },
      {
        availability: () => ({ state: "disabled", reason: "Unavailable" }),
      },
    );
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      overlays: [
        {
          id: "dialog",
          kind: "modal",
          openedAt: 1,
          allowGlobalCommands: ["allowed"],
        },
      ],
    });
    const resolution = resolveShortcut(event(), [allowed], context);
    expect(resolution.type).toBe("command");
    if (resolution.type === "command") {
      expect(resolution.availability.state).toBe("disabled");
      expect(resolution.preventDefault).toBe(false);
    }
  });

  it("protects text entry, editors, terminals, and browser tab shortcuts", () => {
    const view = command("view", { kind: "view", ownerId: "media" });
    const global = command("global", { kind: "global", ownerId: "app" });
    const textContext = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      activeView: "media",
      focus: { kind: "text-entry", ownerPath: [] },
    });
    expect(resolveShortcut(event(), [view], textContext).type).toBe("none");
    expect(resolveShortcut(event(), [global], textContext).type).toBe(
      "command",
    );
    for (const kind of ["editor", "terminal"] as const) {
      expect(
        resolveShortcut(event(), [global], {
          ...textContext,
          focus: { kind, ownerPath: [] },
        }).type,
      ).toBe("none");
    }
    const tauriOnly = {
      ...global,
      shortcuts: [{ chord: "Mod+K", runtimes: ["tauri" as const] }],
    };
    expect(
      resolveShortcut(event(), [tauriOnly], {
        ...textContext,
        runtime: "browser",
        focus: { kind: "document", ownerPath: [] },
      }).type,
    ).toBe("none");
  });

  it("requires the accessibility setting for character-only commands", () => {
    const single = {
      ...command("single", { kind: "global", ownerId: "app" }),
      shortcuts: [{ chord: "P" }],
    };
    const singleEvent = event({ key: "p", code: "KeyP", ctrlKey: false });
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
    });
    expect(resolveShortcut(singleEvent, [single], context).type).toBe("none");
    expect(
      resolveShortcut(singleEvent, [single], {
        ...context,
        singleKeyShortcutsEnabled: true,
      }).type,
    ).toBe("command");
  });
});
