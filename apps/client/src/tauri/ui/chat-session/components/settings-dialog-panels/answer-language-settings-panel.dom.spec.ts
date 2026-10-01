// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadUserAnswerLanguage,
  saveUserAnswerLanguage,
} from "../../../runtime";
import { AnswerLanguageSettingsPanel } from "./answer-language-settings-panel";

vi.mock("../../../runtime", () => ({
  loadUserAnswerLanguage: vi.fn(),
  saveUserAnswerLanguage: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadUserAnswerLanguage).mockResolvedValue("English");
  vi.mocked(saveUserAnswerLanguage).mockImplementation(
    async (language) => language,
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const renderLoadedPanel = async (): Promise<HTMLInputElement> => {
  render(createElement(AnswerLanguageSettingsPanel));
  const input = screen.getByRole("textbox", {
    name: "Answer language",
  }) as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
};

describe("answer language settings", () => {
  it("loads English and saves another language to shared settings", async () => {
    const input = await renderLoadedPanel();
    expect(input.value).toBe("English");
    fireEvent.change(input, { target: { value: " German " } });
    await waitFor(() =>
      expect(saveUserAnswerLanguage).toHaveBeenCalledWith("German"),
    );
  });

  it("loads a CLI preference and clears the language instruction", async () => {
    vi.mocked(loadUserAnswerLanguage).mockResolvedValue("German");
    const input = await renderLoadedPanel();
    expect(input.value).toBe("German");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Not set");
    await waitFor(() =>
      expect(saveUserAnswerLanguage).toHaveBeenCalledWith(""),
    );
  });

  it("preserves a cleared preference when reopened", async () => {
    vi.mocked(loadUserAnswerLanguage).mockResolvedValue("");
    expect((await renderLoadedPanel()).value).toBe("");
    expect(saveUserAnswerLanguage).not.toHaveBeenCalled();
  });

  it("keeps failed changes available for retry", async () => {
    vi.mocked(saveUserAnswerLanguage).mockRejectedValue(
      new Error("Write failed"),
    );
    const input = await renderLoadedPanel();
    fireEvent.change(input, { target: { value: "German" } });
    await waitFor(() =>
      expect(
        screen.getByText("Failed to save answer language. Try again."),
      ).toBeTruthy(),
    );
    expect(input.value).toBe("German");
    expect(screen.getByRole("button", { name: "Save now" })).toBeTruthy();
    vi.mocked(saveUserAnswerLanguage).mockResolvedValue("German");
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Failed to save answer language. Try again."),
      ).toBeNull(),
    );
  });
});
