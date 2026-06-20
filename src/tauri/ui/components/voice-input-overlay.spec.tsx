import { fireEvent, render, screen } from "@testing-library/react";
import { VoiceInputOverlay } from "./voice-input-overlay";

describe("VoiceInputOverlay", () => {
  it("renders the shared listening state and stops through the main control", () => {
    const onPrimaryAction = vi.fn();

    render(
      <VoiceInputOverlay
        title="Voice input"
        recording
        transcribing={false}
        level={0.12}
        statusText={null}
        onPrimaryAction={onPrimaryAction}
      />,
    );

    expect(screen.getByText("Voice input")).toBeDefined();
    expect(screen.getByText("Listening")).toBeDefined();
    expect(screen.getByText("Listening...")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it("renders the idle start affordance when requested", () => {
    render(
      <VoiceInputOverlay
        title="Quick Voice"
        recording={false}
        transcribing={false}
        level={0}
        statusText={null}
        idleBadgeText="CommandOrControl+Alt+V"
        showIdleStartAction
        onPrimaryAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready")).toBeDefined();
    expect(screen.getByText("CommandOrControl+Alt+V")).toBeDefined();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
  });
});
