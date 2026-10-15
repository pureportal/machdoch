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
  it("blocks adaptive keyboard commands while using Goal", async () => {
    const onChange = vi.fn();
    const command = createAdaptiveControllerCommand(
      true,
      false,
      onChange,
      false,
      "Unavailable while using Goal.",
    );
    expect(command.availability?.(context)).toEqual({
      state: "disabled",
      reason: "Unavailable while using Goal.",
    });
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );
    for (const item of page?.groups[0]?.items ?? []) {
      expect(item.availability).toEqual({
        state: "disabled",
        reason: "Unavailable while using Goal.",
      });
      await item.execute(context, new AbortController().signal);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("blocks parallel keyboard commands in Pose chats", async () => {
    const onChange = vi.fn();
    const command = createParallelAgentCommand(
      "disabled",
      ["disabled", "read-only", "machdoch"],
      onChange,
      "pose",
    );
    expect(command.availability?.(context)).toEqual({
      state: "disabled",
      reason: "Unavailable in Pose chats.",
    });
    const page = await command.children?.(
      context,
      new AbortController().signal,
    );
    const items = page?.groups[0]?.items ?? [];
    for (const item of items.filter(
      (item) => item.id === "read-only" || item.id === "machdoch",
    )) {
      expect(item.availability).toEqual({
        state: "disabled",
        reason: "Unavailable in Pose chats.",
      });
      await item.execute(context, new AbortController().signal);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

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

  it("explains unavailable parallel modes and selects a supported mode", async () => {
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
      { id: "native", current: false },
    ]);
    expect(items[3]?.availability).toEqual({
      state: "disabled",
      reason: "Unavailable for this provider and model.",
    });
    await items[3]?.execute(context, new AbortController().signal);
    expect(onChange).not.toHaveBeenCalled();
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
      reason: "Unavailable for this provider and model.",
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
