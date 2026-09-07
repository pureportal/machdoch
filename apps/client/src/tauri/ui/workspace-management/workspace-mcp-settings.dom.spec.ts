// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import {
  discoverMcpServer,
  loadMcpConfigDocument,
  saveMcpConfigDocument,
  type McpCommandDiscoveryResult,
  type McpConfigDocument,
} from "../runtime";
import { WorkspaceMcpSettings } from "./workspace-mcp-settings";

vi.mock("../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime")>()),
  loadMcpConfigDocument: vi.fn(),
  saveMcpConfigDocument: vi.fn(),
  discoverMcpServer: vi.fn(),
  subscribeToUserSettingsChanged: vi.fn(async () => () => {}),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([false, true])(
  "clears old discovery when saving, including an in-flight response: %s",
  async (pending) => {
    const user = userEvent.setup();
    const workspaceRoot = "C:\\workspace";
    const document: McpConfigDocument = {
      scope: "workspace",
      path: "C:\\workspace\\.machdoch\\mcp\\mcp.json",
      exists: true,
      raw: JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "blockbench",
            enabled: true,
            transport: { type: "stdio", command: "npx", args: ["mcp-add"] },
          },
        ],
      }),
    };
    const discovery: McpCommandDiscoveryResult = {
      workspaceRoot,
      discovery: { serverId: "blockbench", transportType: "stdio", tools: [] },
    };
    vi.mocked(loadMcpConfigDocument).mockResolvedValue(document);
    vi.mocked(saveMcpConfigDocument).mockImplementation(
      async (_scope, raw) => ({ ...document, raw }),
    );
    vi.mocked(discoverMcpServer).mockResolvedValue(discovery);
    render(
      createElement(TooltipProvider, {
        children: createElement(WorkspaceMcpSettings, { workspaceRoot }),
      }),
    );
    await screen.findByRole("combobox", { name: "Transport" });
    await user.click(screen.getByRole("tab", { name: "Capabilities" }));
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));
    await screen.findByText("Transport: stdio");

    let completeDiscovery:
      | ((result: McpCommandDiscoveryResult) => void)
      | undefined;
    if (pending) {
      vi.mocked(discoverMcpServer).mockReturnValue(
        new Promise((resolve) => {
          completeDiscovery = resolve;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Discover" }));
    }
    await user.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Transport" }), {
      target: { value: "streamable-http" },
    });
    fireEvent.change(screen.getByLabelText("URL", { exact: true }), {
      target: { value: "http://localhost:32123/bb-mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(
      "MCP settings saved. Start a new provider run to use changes.",
    );
    await act(async () => completeDiscovery?.(discovery));
    await user.click(screen.getByRole("tab", { name: "Capabilities" }));
    expect(screen.queryByText("Transport: stdio")).toBeNull();
    expect(screen.queryByText("Raw discovery output")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Discover",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      JSON.parse(vi.mocked(saveMcpConfigDocument).mock.calls[0]![1]).servers[0]
        .transport,
    ).toEqual({
      type: "streamable-http",
      url: "http://localhost:32123/bb-mcp",
    });
  },
);
