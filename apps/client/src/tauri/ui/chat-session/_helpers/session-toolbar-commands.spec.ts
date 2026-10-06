import { describe, expect, it, vi } from "vitest";
import type { CommandContextSnapshot } from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { createParallelAgentCommand } from "./session-toolbar-commands";
import { createAdaptiveControllerCommand } from "@machdoch/client-ui/composer/adaptive-controller-command";

const context: CommandContextSnapshot = {
  windowKind: "main",
  platform: "windows",
  runtime: "browser",
  activeView: "chat",
  focus: { kind: "document", ownerPath: [] },
  overlays: [],
  singleKeyShortcutsEnabled: false,
  busyCommands: new Set(),
};

describe("session toolbar commands", () => {
  it("offers the resolved adaptive default and both explicit overrides", async () => {
    const onChange = vi.fn();
    const command = createAdaptiveControllerCommand(null, true, onChange);
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );
    const items = page?.groups[0]?.items ?? [];

    expect(
      items.map(({ id, title, current }) => ({ id, title, current })),
    ).toEqual([
      { id: "default", title: "Default (Enabled)", current: true },
      { id: "enabled", title: "Enabled", current: false },
      { id: "disabled", title: "Disabled", current: false },
    ]);
    await items[2]?.execute(context, new AbortController().signal);
    await items[0]?.execute(context, new AbortController().signal);
    expect(onChange.mock.calls).toEqual([[false], [null]]);
  });

  it("marks an explicit adaptive override as current", async () => {
    const command = createAdaptiveControllerCommand(false, null, vi.fn());
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );

    expect(
      page?.groups[0]?.items.map(({ title, current }) => ({ title, current })),
    ).toEqual([
      { title: "Default", current: false },
      { title: "Enabled", current: false },
      { title: "Disabled", current: true },
    ]);
  });

  it("offers only supported parallel agent modes and selects the requested mode", async () => {
    const onChange = vi.fn();
    const command = createParallelAgentCommand(
      "read-only",
      ["disabled", "read-only", "machdoch"],
      onChange,
    );
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );
    const items = page?.groups[0]?.items ?? [];

    expect(command.availability?.(context)).toEqual({ state: "enabled" });
    expect(items.map(({ id, current }) => ({ id, current }))).toEqual([
      { id: "disabled", current: false },
      { id: "read-only", current: true },
      { id: "machdoch", current: false },
    ]);
    await items[2]?.execute(context, new AbortController().signal);
    expect(onChange).toHaveBeenCalledWith("machdoch");
  });

  it("disables parallel selection when no alternative mode exists", () => {
    const command = createParallelAgentCommand(
      "disabled",
      ["disabled"],
      vi.fn(),
    );

    expect(command.availability?.(context)).toEqual({
      state: "disabled",
      reason: "Parallel agents unavailable",
    });
  });

  it("includes Native when the selected model supports it", async () => {
    const command = createParallelAgentCommand(
      "native",
      ["disabled", "read-only", "machdoch", "native"],
      vi.fn(),
    );
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );

    expect(
      page?.groups[0]?.items.map(({ id, current }) => ({ id, current })),
    ).toEqual([
      { id: "disabled", current: false },
      { id: "read-only", current: false },
      { id: "machdoch", current: false },
      { id: "native", current: true },
    ]);
  });
});
