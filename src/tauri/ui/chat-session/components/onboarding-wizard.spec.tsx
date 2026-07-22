import { fireEvent, render, screen } from "@testing-library/react";
import { createSession } from "../../chat-session.model";
import { OnboardingWizard } from "./onboarding-wizard";

const renderOnboarding = (): void => {
  render(
    <OnboardingWizard
      activeSession={createSession({
        workspace: "C:\\Project",
        provider: "openai",
        model: "gpt-5.5",
      })}
      chooserProviders={["openai"]}
      hasAnyProvider
      isUiControlAvailable
      uiControlDescription="Desktop control is available."
      providerSetup={{
        provider: "openai",
        keyValue: "",
        loading: false,
        saving: false,
        message: null,
        onProviderChange: vi.fn(),
        onOpenProviderPortal: vi.fn(),
        onKeyChange: vi.fn(),
        onSave: vi.fn(async () => true),
      }}
      desktopSetup={{
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
      }}
      voiceSetup={{
        supported: true,
        systemVoicesSupported: true,
        autoSpeakResponses: false,
        availabilityDescription: "Available",
        speechToTextAvailabilityDescription: "Available",
        speechToTextProvider: "none",
        speechToTextProviderAvailability: [],
        speechToTextProviderSaving: false,
        speechInputDeviceId: null,
        speechInputDevicesSupported: true,
        speechInputDevicesRefreshing: false,
        speechInputDeviceSaving: false,
        speechInputDevices: [],
        speechInputDeviceMessage: null,
        speechToTextProviderMessage: null,
        aiProvider: "none",
        aiProviderAvailability: [],
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
      }}
      onSelectFolder={vi.fn(async () => undefined)}
      onSessionModelSelection={vi.fn()}
      onSessionModeSelection={vi.fn()}
      onUiControlEnabledChange={vi.fn()}
      onFinish={vi.fn()}
      onSkip={vi.fn()}
    />,
  );
};

describe("OnboardingWizard", () => {
  it("shows provider sync and its enable warning in the first-start Workspace step", async () => {
    renderOnboarding();

    fireEvent.click(screen.getByRole("button", { name: /WorkspaceSet/u }));

    expect(
      await screen.findByRole("switch", {
        name: "Sync Machdoch to provider CLIs",
      }),
    ).toBeDefined();
    expect(
      screen.getByText(
        /Enabling removes existing provider-native instruction, MCP, and customization files or entries/u,
      ),
    ).toBeDefined();
  });
});
