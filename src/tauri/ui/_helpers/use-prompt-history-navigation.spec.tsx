import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { describe, expect, it } from "vitest";
import { usePromptHistoryNavigation } from "./use-prompt-history-navigation";

const PromptHistoryHarness = (): JSX.Element => {
  const [value, setValue] = useState("Current draft");
  const historyNavigation = usePromptHistoryNavigation({
    value,
    history: ["Oldest request", "Newest request"],
    onValueChange: setValue,
  });

  return (
    <textarea
      aria-label="Prompt"
      value={value}
      onChange={(event) =>
        historyNavigation.handleValueChange(event.target.value)
      }
      onKeyDown={historyNavigation.handleKeyDown}
    />
  );
};

describe("usePromptHistoryNavigation", () => {
  it("cycles backward and forward before restoring the current draft", () => {
    render(<PromptHistoryHarness />);
    const textarea = screen.getByRole("textbox", {
      name: "Prompt",
    }) as HTMLTextAreaElement;

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("Newest request");

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("Oldest request");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("Newest request");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("Current draft");
  });

  it("keeps arrow keys available for normal caret movement until browsing starts", () => {
    render(<PromptHistoryHarness />);
    const textarea = screen.getByRole("textbox", {
      name: "Prompt",
    }) as HTMLTextAreaElement;

    textarea.setSelectionRange(4, 4);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("Current draft");

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("Current draft");
  });

  it("uses an edited history entry as the next draft to restore", () => {
    render(<PromptHistoryHarness />);
    const textarea = screen.getByRole("textbox", {
      name: "Prompt",
    }) as HTMLTextAreaElement;

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.change(textarea, { target: { value: "Edited request" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("Edited request");

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("Newest request");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("Edited request");
  });
});
