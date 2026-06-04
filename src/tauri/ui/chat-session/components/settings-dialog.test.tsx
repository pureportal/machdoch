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
    fireEvent.click(screen.getByRole("button", { name: "Emerald" }));
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
});
