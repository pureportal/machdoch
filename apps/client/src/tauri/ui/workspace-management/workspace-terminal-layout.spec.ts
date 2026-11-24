import { describe, expect, it } from "vitest";
import {
  activateTerminalTab,
  addTerminalTab,
  closeTerminalTab,
  colorTerminalTab,
  DEFAULT_TERMINAL_LAYOUT,
  MAX_SAVED_SCROLLBACK_CHARS,
  normalizeTerminalLayout,
  readTerminalLayout,
  readTerminalCommandHistory,
  readTerminalScrollback,
  rememberTerminalCommand,
  renameTerminalTab,
  restorableTerminalTabs,
  splitTerminal,
  writeTerminalCommandHistory,
  writeTerminalLayout,
  writeTerminalScrollback,
} from "./workspace-terminal-layout";

const tab = (id: string, shellId = "pwsh") => ({
  id,
  shellId,
  name: null,
  color: null,
  cwd: null,
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

describe("terminal layout", () => {
  it("renames, colours, splits and closes tabs with a valid active tab", () => {
    let layout = addTerminalTab(DEFAULT_TERMINAL_LAYOUT, tab("a"));
    layout = addTerminalTab(layout, tab("b", "bash"));
    layout = addTerminalTab(layout, tab("c"));
    layout = renameTerminalTab(layout, "a", "  API server  ");
    layout = colorTerminalTab(layout, "a", "emerald");
    expect(layout.tabs[0]).toMatchObject({
      name: "API server",
      color: "emerald",
    });
    expect(layout.activeTabId).toBe("c");

    layout = splitTerminal(layout, "a", "vertical");
    expect(layout.split).toEqual({ tabId: "a", direction: "vertical" });
    expect(splitTerminal(layout, "c", "horizontal")).toBe(layout);

    layout = activateTerminalTab(layout, "a");
    expect(layout.activeTabId).toBe("a");
    expect(layout.split?.tabId).toBe("c");

    layout = closeTerminalTab(layout, "a");
    expect(layout.activeTabId).toBe("c");
    expect(layout.split).toBeNull();
    layout = closeTerminalTab(layout, "c");
    expect(layout.activeTabId).toBe("b");
    expect(closeTerminalTab(layout, "b").activeTabId).toBeNull();
  });

  it("remembers the layout per workspace and rejects invalid stored values", () => {
    const storage = memoryStorage();
    const layout = {
      ...addTerminalTab(
        addTerminalTab(DEFAULT_TERMINAL_LAYOUT, tab("a")),
        tab("b"),
      ),
      dock: "side" as const,
      scrollbackLines: 50_000,
    };
    writeTerminalLayout(storage, "c:/work", layout);
    expect(readTerminalLayout(storage, "c:/work")).toEqual(layout);
    expect(readTerminalLayout(storage, "c:/other")).toEqual(
      DEFAULT_TERMINAL_LAYOUT,
    );
    expect(
      normalizeTerminalLayout({
        tabs: [{ id: "x", shellId: "pwsh", color: "neon" }, { id: "" }],
        activeTabId: "missing",
        split: { tabId: "x", direction: "vertical" },
        dock: "ceiling",
        scrollbackLines: 10,
      }),
    ).toEqual({
      tabs: [{ id: "x", shellId: "pwsh", name: null, color: null, cwd: null }],
      activeTabId: "x",
      split: null,
      dock: "bottom",
      size: 260,
      scrollbackLines: 1_000,
    });
  });

  it("keeps a bounded copy of the scrollback for restart", () => {
    const storage = memoryStorage();
    writeTerminalScrollback(
      storage,
      "w",
      "a",
      "x".repeat(MAX_SAVED_SCROLLBACK_CHARS + 10),
    );
    expect(readTerminalScrollback(storage, "w", "a")).toHaveLength(
      MAX_SAVED_SCROLLBACK_CHARS,
    );
    writeTerminalScrollback(storage, "w", "a", null);
    expect(readTerminalScrollback(storage, "w", "a")).toBeNull();
  });

  it("restores tabs with an available shell and falls back to the default", () => {
    const tabs = [tab("a", "pwsh"), tab("b", "gone"), tab("c", "bash")];
    expect(
      restorableTerminalTabs(tabs, ["bash", "pwsh"], "pwsh").map(
        (entry) => entry.shellId,
      ),
    ).toEqual(["pwsh", "pwsh", "bash"]);
    expect(
      restorableTerminalTabs(tabs, ["bash"], "missing").map(
        (entry) => entry.shellId,
      ),
    ).toEqual(["bash", "bash", "bash"]);
    expect(restorableTerminalTabs(tabs, [], null)).toEqual([]);
  });

  it("keeps the most recent unique commands", () => {
    let history = rememberTerminalCommand([], "git status");
    history = rememberTerminalCommand(history, "pnpm test");
    history = rememberTerminalCommand(history, "  git status ");
    history = rememberTerminalCommand(history, "   ");
    expect(history).toEqual(["git status", "pnpm test"]);
    const storage = memoryStorage();
    writeTerminalCommandHistory(storage, "w", history);
    expect(readTerminalCommandHistory(storage, "w")).toEqual(history);
    storage.setItem("machdoch.terminal-commands:w", "{broken");
    expect(readTerminalCommandHistory(storage, "w")).toEqual([]);
  });
});
