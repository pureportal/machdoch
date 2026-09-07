// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { McpSettingsPanel } from "./mcp-settings-panel";
import type { McpSettingsControls } from "./types";

afterEach(cleanup);

const renderSettings = (servers: Record<string, unknown>[] = []) => {
  const raw = JSON.stringify({ schemaVersion: 1, servers });
  const onSave = vi.fn<(draft: string) => void>();
  const Panel = () => {
    const [draft, setDraft] = useState(raw);
    const setup: McpSettingsControls = {
      workspaceRoot: null,
      document: {
        scope: "user",
        path: "/settings/mcp.json",
        exists: true,
        raw,
      },
      draft,
      presets: [],
      commandsAvailable: false,
      loading: false,
      saving: false,
      discoveryServerId: "",
      discoveryBusy: false,
      discoveryOutput: null,
      oauthServerId: "",
      oauthCallback: "",
      oauthBusy: false,
      message: null,
      onDraftChange: setDraft,
      onSave: () => onSave(draft),
      onPresetInsert: vi.fn(),
      onDiscoveryServerIdChange: vi.fn(),
      onDiscoverServer: vi.fn(),
      onRefreshDiscoveryCache: vi.fn(),
      onListDiscoveryCache: vi.fn(),
      onOAuthServerIdChange: vi.fn(),
      onOAuthCallbackChange: vi.fn(),
      onStartOAuth: vi.fn(),
      onFinishOAuth: vi.fn(),
    };
    return createElement(McpSettingsPanel, { setup, showProviderSync: false });
  };
  const result = render(
    createElement(TooltipProvider, { children: createElement(Panel) }),
  );
  return { ...result, onSave };
};

describe("MCP settings interactions", () => {
  it("removes stdio fields when switching to HTTP and saving", () => {
    const { onSave } = renderSettings([
      {
        id: "blockbench",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["mcp-add"],
          cwd: "old-directory",
          env: { STDIO_ONLY: "true" },
          inheritEnvironment: true,
          stderr: "pipe",
        },
      },
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Transport" }), {
      target: { value: "streamable-http" },
    });
    fireEvent.change(screen.getByLabelText("URL", { exact: true }), {
      target: { value: "http://localhost:32123/bb-mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(onSave.mock.calls[0]![0]);
    expect(saved.servers[0].transport).toEqual({
      type: "streamable-http",
      url: "http://localhost:32123/bb-mcp",
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Transport" }), {
      target: { value: "stdio" },
    });
    expect(
      (screen.getByLabelText("Command", { exact: true }) as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("shows transport validation after interaction and clears it when corrected", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add custom" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Add custom MCP server" }),
    );
    expect(dialog.queryByRole("alert")).toBeNull();
    const command = dialog.getByLabelText("Command", { exact: true });
    fireEvent.blur(command);
    expect(command.getAttribute("aria-invalid")).toBe("true");
    expect(command.getAttribute("aria-describedby")).toBe(
      dialog.getByRole("alert").id,
    );

    fireEvent.change(dialog.getByRole("combobox", { name: "Transport" }), {
      target: { value: "streamable-http" },
    });
    expect(dialog.queryByRole("alert")).toBeNull();
    const url = dialog.getByLabelText("URL", { exact: true });
    fireEvent.change(url, { target: { value: "invalid" } });
    fireEvent.blur(url);
    expect(url.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(url, { target: { value: "http://localhost:9999/mcp" } });
    expect(dialog.queryByRole("alert")).toBeNull();
    expect(
      (dialog.getByRole("button", { name: "Add server" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    expect(
      screen.queryByRole("dialog", { name: "Add custom MCP server" }),
    ).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("switches server sections with arrow keys and keeps panels associated with their tabs", async () => {
    renderSettings([
      {
        id: "local",
        title: "Local",
        transport: { type: "stdio", command: "node" },
      },
    ]);
    const setup = screen.getByRole("tab", { name: "Setup" });
    setup.focus();
    fireEvent.keyDown(setup, { key: "ArrowRight" });
    const auth = screen.getByRole("tab", { name: "Auth" });
    await waitFor(() =>
      expect(auth.getAttribute("aria-selected")).toBe("true"),
    );
    expect(document.activeElement).toBe(auth);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      auth.id,
    );
    fireEvent.keyDown(auth, { key: "End" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Advanced" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
});
