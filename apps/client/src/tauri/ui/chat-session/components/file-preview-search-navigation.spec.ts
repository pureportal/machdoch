// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  FilePreviewTextContent,
  type FilePreview,
} from "./file-preview-dialog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("moves between search matches without rebuilding the code DOM", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", undefined);
  const preview: FilePreview = {
    title: "notes.txt",
    path: "notes.txt",
    mode: "text",
    loading: false,
    error: null,
    source: null,
    content: "line one\nline two",
    language: null,
    languageLabel: "Text",
    truncated: false,
    lossy: false,
    targetLine: null,
  };
  const { container } = render(
    createElement(FilePreviewTextContent, { preview }),
  );
  fireEvent.change(screen.getByLabelText("Find in file"), {
    target: { value: "line" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
  const marks = Array.from(container.querySelectorAll("mark"));
  expect(marks).toHaveLength(2);
  expect(marks[0]?.dataset.filePreviewMatch).toBe("active");
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(Array.from(container.querySelectorAll("mark"))).toEqual(marks);
  expect(marks[0]?.dataset.filePreviewMatch).toBe("match");
  expect(marks[1]?.dataset.filePreviewMatch).toBe("active");
  expect(container.querySelector("code")?.textContent).toBe(preview.content);
});
