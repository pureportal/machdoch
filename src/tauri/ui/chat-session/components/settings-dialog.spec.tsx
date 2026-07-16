import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog } from "../../components/ui/dialog";
import { SettingsDialog, type SettingsDialogProps } from "./settings-dialog";

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const createSettingsDialogProps = (
  overrides: Partial<SettingsDialogProps> = {},
): SettingsDialogProps => ({
  settingsSection: "providers",
  onSettingsSectionChange: vi.fn(),
  providerSetup: {
    provider: "openai",
    keyValue: "sk-old",
    saving: false,
    message: null,
    onProviderChange: vi.fn(),
    onOpenProviderPortal: vi.fn(),
    onKeyChange: vi.fn(),
    onSave: vi.fn(async () => true),
  },
  workspaceSetup: {
    workspaceRoot: "C:\\Project",
    workspaceLabel: "Project",
    defaultMode: "ask",
    effectiveMode: "ask",
    defaultReasoning: "default",
    effectiveReasoning: "default",
    reasoningProvider: "openai",
    reasoningModel: "gpt-5.5",
    saving: false,
    message: null,
    onDefaultModeChange: vi.fn(),
    onReasoningModeChange: vi.fn(),
  },
  instructionsSetup: {
    workspaceRoot: "C:\\Project",
    instructions: [
      {
        kind: "conditional",
        path: ".machdoch/instructions/review.instructions.md",
        name: "Review Rules",
        body: "Prefer strict TypeScript and targeted tests.",
        applyToPatterns: ["src/**/*.ts"],
        excludePatterns: ["dist/**"],
        keywords: ["review"],
        mode: "auto",
        scope: "workspace",
      },
    ],
    diagnostics: [],
    loading: false,
    saving: false,
    message: null,
    onRefresh: vi.fn(),
    onManualSave: vi.fn(),
    onGenerate: vi.fn(),
  },
  webSearchSetup: {
    activeProvider: "none",
    provider: "perplexity",
    keyValue: "pplx-old",
    saving: false,
    message: null,
    onActiveProviderChange: vi.fn(),
    onProviderChange: vi.fn(),
    onKeyChange: vi.fn(),
    onSave: vi.fn(async () => true),
  },
  mcpSetup: {
    workspaceRoot: "C:\\Project",
    scope: "user",
    document: {
      scope: "user",
      path: "C:\\Users\\Test\\AppData\\Roaming\\machdoch\\mcp.json",
      exists: true,
      raw: '{\n  "schemaVersion": 1,\n  "servers": []\n}\n',
    },
    draft: '{\n  "schemaVersion": 1,\n  "servers": []\n}\n',
    presets: [
      {
        id: "serper-search",
        title: "Serper Search",
        description: "Google search through Serper.",
        serverId: "serper",
        serverTitle: "Serper Search",
      },
      {
        id: "github-remote",
        title: "GitHub Remote",
        description: "GitHub hosted MCP endpoint.",
        serverId: "github",
        serverTitle: "GitHub Remote",
      },
    ],
    workspaceAvailable: true,
    loading: false,
    saving: false,
    discoveryServerId: "serper",
    discoveryBusy: false,
    discoveryOutput: null,
    oauthServerId: "github",
    oauthCallback: "http://127.0.0.1:43110/oauth/callback?code=abc",
    oauthBusy: false,
    message: null,
    onScopeChange: vi.fn(),
    onDraftChange: vi.fn(),
    onSave: vi.fn(),
    onPresetInsert: vi.fn(),
    onDiscoveryServerIdChange: vi.fn(),
    onDiscoverServer: vi.fn(),
    onRefreshDiscoveryCache: vi.fn(),
    onListDiscoveryCache: vi.fn(),
    onOAuthServerIdChange: vi.fn(),
    onOAuthCallbackChange: vi.fn(),
    onStartOAuth: vi.fn(),
    onFinishOAuth: vi.fn(),
  },
  agentLimitsSetup: {
    settings: {
      infinite: false,
      executorTurns: 64,
      autopilotExecutorIterations: 16,
    },
    reviewModelSettings: {
      mode: "base",
    },
    providerAvailability: [
      { provider: "openai", configured: true },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: true },
    ],
    saving: false,
    message: null,
    onSave: vi.fn(),
    onReviewModelSave: vi.fn(),
  },
  appearanceSetup: {
    settings: {
      version: 1,
      theme: "dark",
      density: "comfortable",
      accent: "sky",
      quickChatBubbleStyle: "classic",
    },
    saving: false,
    onSave: vi.fn(),
  },
  memorySetup: {
    settings: {
      globalEnabled: false,
      entries: [],
    },
    saving: false,
    message: null,
    onGlobalEnabledChange: vi.fn(),
  },
  desktopSetup: {
    settings: {
      autostartEnabled: false,
      autostartMinimized: false,
      autostartToTray: false,
      alwaysRunAsAdministrator: false,
      assistantBubbleEnabled: true,
      assistantBubbleHideWhenFullscreen: true,
      assistantBubbleTemporarilyHideSeconds: 6,
      aiContextMaxMessages: 60,
      inactiveSessionArchiveDays: 7,
      archivedSessionRetentionDays: 7,
      quickVoiceEnabled: true,
      quickVoiceShortcut: "CommandOrControl+Alt+V",
      quickVoiceSilenceSeconds: 1.8,
      quickVoiceMaxMessages: 50,
    },
    saving: false,
    message: null,
    onSave: vi.fn(),
  },
  voiceSetup: {
    supported: true,
    systemVoicesSupported: true,
    autoSpeakResponses: false,
    availabilityDescription: "System voices are available.",
    speechToTextAvailabilityDescription: "Speech input is available.",
    speechToTextProvider: "none",
    speechToTextProviderAvailability: [
      { provider: "openai", configured: true },
      { provider: "google", configured: false },
    ],
    speechToTextProviderSaving: false,
    speechInputDeviceId: null,
    speechInputDevicesSupported: true,
    speechInputDevicesRefreshing: false,
    speechInputDeviceSaving: false,
    speechInputDevices: [],
    speechInputDeviceMessage: null,
    speechToTextProviderMessage: null,
    aiProvider: "none",
    aiProviderAvailability: [
      { provider: "openai", configured: true },
      { provider: "google", configured: false },
    ],
    aiProviderSaving: false,
    aiProviderMessage: null,
    preferredVoiceURI: null,
    rate: 1,
    voiceOptions: [],
    onSpeechToTextProviderChange: vi.fn(),
    onSpeechInputDeviceChange: vi.fn(),
    onRefreshSpeechInputDevices: vi.fn(),
    onAiProviderChange: vi.fn(),
    onAutoSpeakResponsesChange: vi.fn(),
    onPreferredVoiceChange: vi.fn(),
    onRateChange: vi.fn(),
  },
  ...overrides,
});

const renderSettingsDialog = (props: SettingsDialogProps): void => {
  render(
    <Dialog open>
      <SettingsDialog {...props} />
    </Dialog>,
  );
};

describe("SettingsDialog", () => {
  it("offers credentials for remote media providers", () => {
    const onProviderChange = vi.fn();
    const props = createSettingsDialogProps({
      providerSetup: {
        ...createSettingsDialogProps().providerSetup,
        onProviderChange,
      },
    });

    renderSettingsDialog(props);

    expect(screen.getByRole("button", { name: "Quiver" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recraft" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Quiver" }));
    expect(onProviderChange).toHaveBeenCalledWith("quiver");
  });

  it("validates provider API key drafts before auto-saving", async () => {
    const onSave = vi.fn(async () => true);
    const props = createSettingsDialogProps({
      providerSetup: {
        ...createSettingsDialogProps().providerSetup,
        onSave,
      },
    });

    renderSettingsDialog(props);

    const keyInput = screen.getByDisplayValue("sk-old");

    fireEvent.change(keyInput, {
      target: { value: "   " },
    });

    expect(
      await screen.findByText(/Enter a valid OpenAI API key\./i),
    ).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(keyInput, {
      target: { value: " sk-new " },
    });
    expect(
      screen.getByText("Provider key changes will save automatically"),
    ).toBeDefined();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("sk-new");
    });
  });

  it("saves the current web-search key draft value", async () => {
    const onSave = vi.fn(async () => true);
    const props = createSettingsDialogProps({
      settingsSection: "web-search",
      webSearchSetup: {
        ...createSettingsDialogProps().webSearchSetup,
        onSave,
      },
    });

    renderSettingsDialog(props);

    fireEvent.change(screen.getByDisplayValue("pplx-old"), {
      target: { value: " pplx-new " },
    });

    expect(
      screen.getByText("Web-search key changes will save automatically"),
    ).toBeDefined();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("pplx-new");
    });
  });

  it("saves appearance choices", () => {
    const onSave = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "appearance",
      appearanceSetup: {
        ...createSettingsDialogProps().appearanceSetup,
        onSave,
      },
    });

    renderSettingsDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    fireEvent.click(screen.getByRole("button", { name: "Sage" }));
    fireEvent.click(screen.getByRole("button", { name: "Orbit" }));

    expect(onSave).toHaveBeenCalledWith({
      version: 1,
      theme: "light",
      density: "comfortable",
      accent: "sky",
      quickChatBubbleStyle: "classic",
    });
    expect(onSave).toHaveBeenCalledWith({
      version: 1,
      theme: "dark",
      density: "compact",
      accent: "sky",
      quickChatBubbleStyle: "classic",
    });
    expect(onSave).toHaveBeenCalledWith({
      version: 1,
      theme: "dark",
      density: "comfortable",
      accent: "emerald",
      quickChatBubbleStyle: "classic",
    });
    expect(onSave).toHaveBeenCalledWith({
      version: 1,
      theme: "dark",
      density: "comfortable",
      accent: "sky",
      quickChatBubbleStyle: "orbit",
    });
  });

  it("saves workspace default mode choices", () => {
    const onDefaultModeChange = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "workspace",
      workspaceSetup: {
        ...createSettingsDialogProps().workspaceSetup,
        onDefaultModeChange,
      },
    });

    renderSettingsDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "Machdoch" }));

    expect(onDefaultModeChange).toHaveBeenCalledWith("machdoch");
  });

  it("filters workspace reasoning choices for the active model", () => {
    const onReasoningModeChange = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "workspace",
      workspaceSetup: {
        ...createSettingsDialogProps().workspaceSetup,
        onReasoningModeChange,
      },
    });

    renderSettingsDialog(props);

    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Minimal" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "XHigh" }));

    expect(onReasoningModeChange).toHaveBeenCalledWith("xhigh");
  });

  it("loads and saves instruction files from settings", () => {
    const onManualSave = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "instructions",
      instructionsSetup: {
        ...createSettingsDialogProps().instructionsSetup,
        onManualSave,
      },
    });

    renderSettingsDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "Edit selected" }));
    fireEvent.change(
      screen.getByDisplayValue("Prefer strict TypeScript and targeted tests."),
      {
        target: {
          value: "Prefer strict TypeScript and add focused regression tests.",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));

    expect(onManualSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Review Rules",
        path: ".machdoch/instructions/review.instructions.md",
        prompt: "Prefer strict TypeScript and add focused regression tests.",
        scope: "workspace",
        mode: "auto",
        applyTo: ["src/**/*.ts"],
        exclude: ["dist/**"],
        keywords: ["review"],
      }),
    );
  });

  it("saves a dedicated review model", async () => {
    const onReviewModelSave = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "agent",
      agentLimitsSetup: {
        ...createSettingsDialogProps().agentLimitsSetup,
        onReviewModelSave,
      },
    });

    renderSettingsDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "Dedicated" }));
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    fireEvent.change(screen.getByLabelText("Review LLM"), {
      target: { value: "gemini-2.5-flash-lite" },
    });

    await waitFor(() => {
      expect(onReviewModelSave).toHaveBeenCalledWith({
        mode: "dedicated",
        provider: "google",
        model: "gemini-2.5-flash-lite",
      });
    });
  });

  it("stages MCP presets and edits servers without showing JSON", () => {
    const onPresetInsert = vi.fn();
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const onDiscoverServer = vi.fn();
    const onRefreshDiscoveryCache = vi.fn();
    const onListDiscoveryCache = vi.fn();
    const onOAuthServerIdChange = vi.fn();
    const onOAuthCallbackChange = vi.fn();
    const onStartOAuth = vi.fn();
    const onFinishOAuth = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "mcp",
      mcpSetup: {
        ...createSettingsDialogProps().mcpSetup,
        draft: JSON.stringify(
          {
            schemaVersion: 1,
            servers: [
              {
                id: "serper",
                title: "Serper Search",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: "npx",
                  args: ["-y", "serper-search-mcp@latest"],
                  env: {
                    SERPER_API_KEY: "${env:SERPER_API_KEY}",
                  },
                },
                auth: {
                  type: "oauth",
                },
                exposure: {
                  mode: "hybrid",
                  directTools: true,
                },
              },
            ],
          },
          null,
          2,
        ),
        onPresetInsert,
        onDraftChange,
        onSave,
        onDiscoverServer,
        onRefreshDiscoveryCache,
        onListDiscoveryCache,
        onOAuthServerIdChange,
        onOAuthCallbackChange,
        onStartOAuth,
        onFinishOAuth,
      },
    });

    renderSettingsDialog(props);

    expect(screen.queryByLabelText("MCP JSON config")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add preset" }));
    const presetCategories = screen.getByRole("region", {
      name: "MCP preset categories",
    });
    expect(presetCategories.className).toContain("overflow-y-auto");
    expect(screen.getByRole("heading", { name: "Web & Search" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Code & CI" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /GitHub Remote/u }));
    expect(onPresetInsert).toHaveBeenCalledWith("github-remote");

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Serper Updated" },
    });
    expect(onDraftChange).toHaveBeenCalled();
    expect(
      JSON.parse(
        onDraftChange.mock.calls.at(-1)?.[0] as string,
      ) as Record<string, unknown>,
    ).toMatchObject({
      servers: [
        expect.objectContaining({
          title: "Serper Updated",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Capabilities" }));
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh cache" }));
    fireEvent.click(screen.getByRole("button", { name: "List cache" }));
    expect(onDiscoverServer).toHaveBeenCalledWith("serper");
    expect(onRefreshDiscoveryCache).toHaveBeenCalledWith("serper");
    expect(onListDiscoveryCache).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Auth" }));
    expect(
      screen.getByText(
        /Manual fallback: paste a callback URL or code/u,
      ),
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText("MCP OAuth callback URL or code"), {
      target: { value: "http://127.0.0.1:43110/oauth/callback?code=def" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start OAuth" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish OAuth" }));
    expect(onOAuthCallbackChange).toHaveBeenCalledWith(
      "http://127.0.0.1:43110/oauth/callback?code=def",
    );
    expect(onStartOAuth).toHaveBeenCalledWith("serper");
    expect(onFinishOAuth).toHaveBeenCalledWith(
      "serper",
      "http://127.0.0.1:43110/oauth/callback?code=def",
    );
  });

  it("adds a custom MCP server only after required setup is complete", () => {
    const onDraftChange = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "mcp",
      mcpSetup: {
        ...createSettingsDialogProps().mcpSetup,
        onDraftChange,
      },
    });

    renderSettingsDialog(props);

    fireEvent.click(screen.getByRole("button", { name: "Add custom" }));

    const addButton = screen.getByRole("button", { name: "Add server" });
    expect(addButton).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "npx" },
    });
    fireEvent.click(addButton);

    expect(onDraftChange).toHaveBeenCalled();
    expect(
      JSON.parse(
        onDraftChange.mock.calls.at(-1)?.[0] as string,
      ) as Record<string, unknown>,
    ).toMatchObject({
      servers: [
        {
          id: "mcp-server",
          title: "MCP Server",
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
          },
        },
      ],
    });
  });

  it("validates MCP server setup and summarizes discovery output", () => {
    const onSave = vi.fn();
    const props = createSettingsDialogProps({
      settingsSection: "mcp",
      mcpSetup: {
        ...createSettingsDialogProps().mcpSetup,
        draft: JSON.stringify(
          {
            schemaVersion: 1,
            servers: [
              {
                id: "broken",
                title: "Broken Server",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: "",
                },
              },
            ],
          },
          null,
          2,
        ),
        discoveryOutput: JSON.stringify(
          {
            workspaceRoot: "C:\\Project",
            discovery: {
              serverId: "broken",
              transportType: "stdio",
              protocolVersion: "2025-03-26",
              discoveredAt: "2026-06-25T00:00:00.000Z",
              tools: [{ name: "tool-a" }, { name: "tool-b" }],
              resources: [{ uri: "file://resource" }],
              resourceTemplates: [],
              prompts: [{ name: "prompt-a" }],
            },
            cachePath: "C:\\Project\\.machdoch\\mcp\\discovery-cache.json",
          },
          null,
          2,
        ),
        onSave,
      },
    });

    renderSettingsDialog(props);

    expect(
      screen.getAllByText("Stdio transport requires a command."),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Capabilities" }));
    expect(screen.getByText("Tools")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("Resources")).toBeDefined();
    expect(screen.getAllByText("1")).toHaveLength(2);
    expect(screen.getByText("Prompts")).toBeDefined();
    expect(screen.getAllByText(/2025-03-26/u).length).toBeGreaterThanOrEqual(1);
  });
});
