import { describe, expect, it } from "vitest";
import { getDefaultCommandShortcut } from "./command-defaults";
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

  it("reuses save only across mutually exclusive views", () => {
    const commands = [
      ["ralph.flow.save", "ralph"],
      ["media.flow.save", "media"],
      ["instructions.file.save", "instructions"],
      ["workspaces.settings.save", "workspaces"],
    ].map(([id, viewId]) =>
      command(
        id!,
        { kind: "view", ownerId: viewId! },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut(
                id as
                  | "ralph.flow.save"
                  | "media.flow.save"
                  | "instructions.file.save"
                  | "workspaces.settings.save",
              ),
              runtimes: ["tauri"],
              allowIn: [
                "document",
                "text-entry",
                "interactive-control",
                "command-surface",
              ],
            },
          ],
        },
      ),
    );
    const saveEvent = event({ key: "s", code: "KeyS" });
    for (const activeView of ["ralph", "media", "instructions", "workspaces"]) {
      const resolution = resolveShortcut(
        saveEvent,
        commands,
        createShortcutContext({
          platform: "windows",
          runtime: "tauri",
          activeView,
          focus: { kind: "text-entry", ownerPath: [] },
        }),
      );
      expect(resolution.type).toBe("command");
      if (resolution.type === "command") {
        expect(resolution.command.scope.ownerId).toBe(activeView);
      }
    }
  });

  it("reuses New only across mutually exclusive views and the mounted Media section", () => {
    const commandOwners = [
      ["chat.session.new", "chat"],
      ["ralph.flow.new", "ralph"],
      ["media.activity.recipe.new", "media"],
      ["instructions.file.new", "instructions"],
      ["workspaces.add", "workspaces"],
    ] as const;
    const commands = commandOwners.map(([id, ownerId]) =>
      command(
        id,
        { kind: "view", ownerId },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut(id),
              runtimes: ["tauri"],
              allowIn: ["document", "text-entry"],
            },
          ],
        },
      ),
    );
    const newEvent = event({ key: "n", code: "KeyN" });

    for (const [, activeView] of commandOwners) {
      const resolution = resolveShortcut(
        newEvent,
        commands,
        createShortcutContext({
          platform: "windows",
          runtime: "tauri",
          activeView,
          focus: { kind: "text-entry", ownerPath: [] },
        }),
      );
      expect(resolution.type).toBe("command");
      if (resolution.type === "command") {
        expect(resolution.command.scope.ownerId).toBe(activeView);
      }
    }
  });

  it("keeps Mod+Y redo on Windows and Linux while macOS uses Mod+Shift+Z", () => {
    const redo = command(
      "ralph.flow.redo",
      { kind: "view", ownerId: "ralph" },
      {
        shortcuts: [
          { chord: getDefaultCommandShortcut("ralph.flow.redo") },
          {
            chord: getDefaultCommandShortcut("ralph.flow.redo-alternate"),
            platforms: ["windows", "linux"],
          },
        ],
      },
    );
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      activeView: "ralph",
    });
    expect(
      resolveShortcut(event({ key: "y", code: "KeyY" }), [redo], context).type,
    ).toBe("command");
    expect(
      resolveShortcut(
        event({
          key: "y",
          code: "KeyY",
          ctrlKey: false,
          metaKey: true,
        }),
        [redo],
        { ...context, platform: "macos" },
      ).type,
    ).toBe("none");
    expect(
      resolveShortcut(
        event({
          key: "z",
          code: "KeyZ",
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
        }),
        [redo],
        { ...context, platform: "macos" },
      ).type,
    ).toBe("command");
  });

  it("reuses media generation and run bindings only for the mounted section", () => {
    const create = command(
      "media.create.generate",
      { kind: "view", ownerId: "media" },
      {
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("media.create.generate"),
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
      },
    );
    const flow = command(
      "media.flow.run",
      { kind: "view", ownerId: "media" },
      {
        shortcuts: [{ chord: getDefaultCommandShortcut("media.flow.run") }],
      },
    );
    const runEvent = event({ key: "Enter", code: "Enter" });
    const context = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      activeView: "media",
    });
    expect(
      resolveShortcut(runEvent, [create], context).type === "command" &&
        (
          resolveShortcut(runEvent, [create], context) as {
            command: CommandDefinition;
          }
        ).command.id,
    ).toBe("media.create.generate");
    expect(
      resolveShortcut(runEvent, [flow], context).type === "command" &&
        (
          resolveShortcut(runEvent, [flow], context) as {
            command: CommandDefinition;
          }
        ).command.id,
    ).toBe("media.flow.run");
    expect(resolveShortcut(runEvent, [create, flow], context).type).toBe(
      "conflict",
    );
  });

  it("reuses section navigation only across mutually exclusive views", () => {
    const commands = [
      command(
        "media.section.create",
        { kind: "view", ownerId: "media" },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut("media.section.create"),
              runtimes: ["tauri"],
              allowIn: ["document", "text-entry"],
            },
          ],
        },
      ),
      command(
        "marketplace.view.discover",
        { kind: "view", ownerId: "marketplace" },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut("marketplace.view.discover"),
              runtimes: ["tauri"],
              allowIn: ["document", "text-entry"],
            },
          ],
        },
      ),
    ];
    const sectionEvent = event({
      key: "1",
      code: "Digit1",
      ctrlKey: false,
      altKey: true,
    });
    for (const activeView of ["media", "marketplace"]) {
      const resolution = resolveShortcut(
        sectionEvent,
        commands,
        createShortcutContext({
          platform: "windows",
          runtime: "tauri",
          activeView,
          focus: { kind: "text-entry", ownerPath: [] },
        }),
      );
      expect(resolution.type).toBe("command");
      if (resolution.type === "command") {
        expect(resolution.command.scope.ownerId).toBe(activeView);
      }
    }
  });

  it("reuses Escape only across mutually exclusive auxiliary surfaces", () => {
    const surfaceIds = ["quick-chat", "quick-voice", "tray"] as const;
    const commands = surfaceIds.map((surfaceId) =>
      command(
        `${surfaceId}.hide`,
        { kind: "view", ownerId: surfaceId },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut(`${surfaceId}.hide`),
              allowIn: ["document", "interactive-control"],
            },
          ],
        },
      ),
    );
    const escapeEvent = event({
      key: "Escape",
      code: "Escape",
      ctrlKey: false,
    });

    for (const activeView of surfaceIds) {
      const resolution = resolveShortcut(
        escapeEvent,
        commands,
        createShortcutContext({
          platform: "windows",
          runtime: "tauri",
          activeView,
          focus: { kind: "interactive-control", ownerPath: [] },
        }),
      );
      expect(resolution.type).toBe("command");
      if (resolution.type === "command") {
        expect(resolution.command.id).toBe(`${activeView}.hide`);
      }
    }
  });

  it("allows explicit ordinary-input shortcuts but never steals from editors or terminals", () => {
    const shortcuts = [
      command(
        "chat.session.reasoning.select",
        { kind: "view", ownerId: "chat" },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut("chat.session.reasoning.select"),
              allowIn: [
                "document",
                "text-entry",
                "interactive-control",
                "command-surface",
              ],
            },
          ],
        },
      ),
      command(
        "chat.task.cancel",
        { kind: "view", ownerId: "chat" },
        {
          shortcuts: [
            {
              chord: getDefaultCommandShortcut("chat.task.cancel"),
              allowIn: [
                "document",
                "text-entry",
                "interactive-control",
                "command-surface",
              ],
            },
          ],
        },
      ),
    ];
    const textContext = createShortcutContext({
      platform: "windows",
      runtime: "tauri",
      activeView: "chat",
      focus: { kind: "text-entry", ownerPath: [] },
    });
    expect(
      resolveShortcut(
        event({ key: "s", code: "KeyS", ctrlKey: false, altKey: true }),
        shortcuts,
        textContext,
      ).type,
    ).toBe("command");
    expect(
      resolveShortcut(
        event({ key: ".", code: "Period" }),
        shortcuts,
        textContext,
      ).type,
    ).toBe("command");
    for (const kind of ["editor", "terminal"] as const) {
      expect(
        resolveShortcut(
          event({ key: "s", code: "KeyS", ctrlKey: false, altKey: true }),
          shortcuts,
          { ...textContext, focus: { kind, ownerPath: [] } },
        ).type,
      ).toBe("none");
      expect(
        resolveShortcut(event({ key: ".", code: "Period" }), shortcuts, {
          ...textContext,
          focus: { kind, ownerPath: [] },
        }).type,
      ).toBe("none");
    }
  });

  it("does not claim desktop-only native browser bindings in browser runtime", () => {
    const newSession = command(
      "chat.session.new",
      { kind: "view", ownerId: "chat" },
      {
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("chat.session.new"),
            runtimes: ["tauri"],
            allowIn: ["document", "text-entry"],
          },
        ],
      },
    );
    const context = createShortcutContext({
      platform: "windows",
      runtime: "browser",
      activeView: "chat",
      focus: { kind: "text-entry", ownerPath: [] },
    });
    expect(
      resolveShortcut(event({ key: "n", code: "KeyN" }), [newSession], context)
        .type,
    ).toBe("none");

    const settings = command(
      "app.settings.open",
      { kind: "global", ownerId: "app" },
      {
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("app.settings.open"),
            runtimes: ["tauri"],
          },
        ],
      },
    );
    expect(
      resolveShortcut(event({ key: ",", code: "Comma" }), [settings], context)
        .type,
    ).toBe("none");
    expect(
      resolveShortcut(event({ key: ",", code: "Comma" }), [settings], {
        ...context,
        runtime: "tauri",
      }).type,
    ).toBe("command");
  });

  it("keeps browser Find native while routing file-preview Find in Tauri", () => {
    const findInPreview = command(
      "file-preview.search.focus",
      { kind: "overlay", ownerId: "file-preview" },
      {
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("file-preview.search.focus"),
            runtimes: ["tauri"],
            allowIn: ["document", "text-entry", "interactive-control"],
          },
        ],
      },
    );
    const context = createShortcutContext({
      platform: "windows",
      runtime: "browser",
      activeView: "chat",
      focus: { kind: "text-entry", ownerPath: ["file-preview"] },
      overlays: [
        {
          id: "file-preview",
          kind: "modal",
          openedAt: 1,
          allowGlobalCommands: ["app.palette.toggle"],
        },
      ],
    });
    const findEvent = event({ key: "f", code: "KeyF" });

    expect(resolveShortcut(findEvent, [findInPreview], context).type).toBe(
      "none",
    );
    expect(
      resolveShortcut(findEvent, [findInPreview], {
        ...context,
        runtime: "tauri",
      }).type,
    ).toBe("command");
  });
});
