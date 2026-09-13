import type { ProductMessage } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions } from "./message-actions";

const message: ProductMessage = {
  id: "message",
  role: "assistant",
  content: "Task results\n\n- **Passed**\n- Ready to review",
  presentation: "message",
  attachments: [],
  actions: {
    canRetry: false,
    canContinue: false,
    canSaveAsContextPack: false,
    canSpeak: false,
    isSpeaking: false,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function harness(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onCommand = vi.fn();
  const element = (value: ProductMessage) => (
    <MessageActions
      message={value}
      sessionId="session"
      pending
      onCommand={onCommand}
    />
  );
  const view = render(element(message));
  return {
    writeText,
    onCommand,
    show: (value: ProductMessage) => view.rerender(element(value)),
  };
}

describe("message copying", () => {
  it("copies exact message text while remote commands are blocked and keeps feedback through polls", async () => {
    const view = harness();
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(view.writeText).toHaveBeenCalledWith(message.content);
    expect(view.onCommand).not.toHaveBeenCalled();
    view.show({ ...message });
    expect(screen.getByRole("button", { name: "Copied message" })).toBeTruthy();
  });

  it("recovers from clipboard denial", async () => {
    const view = harness(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("Denied"))
        .mockResolvedValue(undefined),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Could not copy");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.writeText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Copied message" })).toBeTruthy();
  });

  it("does not claim to have copied newer content after an earlier clipboard write finishes", async () => {
    let resolve!: () => void;
    const view = harness(
      vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    view.show({ ...message, content: "New results" });
    await act(async () => resolve());
    expect(screen.queryByRole("button", { name: "Copied message" })).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Copy message" })
        .disabled,
    ).toBe(false);
  });
});
