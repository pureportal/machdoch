import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductMarkdown } from "./markdown";

const code = '  const message = "hello <world>";\n\tconsole.log(message);\n';
const content = `\`\`\`js\n${code}\n\`\`\``;
const failureMessage = /could not copy|copy failed|unable to copy/i;
let unhandledRejections: unknown[];

function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

function recordWindowRejection(event: PromiseRejectionEvent) {
  unhandledRejections.push(event.reason);
}

function setClipboard(clipboard: { writeText?: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  unhandledRejections = [];
  process.on("unhandledRejection", recordUnhandledRejection);
  window.addEventListener("unhandledrejection", recordWindowRejection);
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", recordUnhandledRejection);
  window.removeEventListener("unhandledrejection", recordWindowRejection);
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  expect(unhandledRejections, "unhandled clipboard rejections").toEqual([]);
});

async function clickCopy(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function expectFailure(block: HTMLElement) {
  const feedback = block.querySelector('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]');
  expect.soft(feedback?.textContent).toMatch(failureMessage);
  expect.soft(block.textContent).toMatch(/retry|try again/i);
  expect.soft(within(block).queryByRole("button", { name: "Copied code block" })).toBeNull();
  expect.soft(within(block).getByRole<HTMLButtonElement>("button").disabled).toBe(false);
}

function renderCodeBlocks() {
  const { container } = render(<ProductMarkdown content={`${content}\n\n\`\`\`text\nsecond block\n\`\`\``} />);
  const blocks = container.querySelectorAll<HTMLElement>(".m-markdown-code-block");
  expect(blocks).toHaveLength(2);
  return { first: blocks[0]!, second: blocks[1]! };
}

describe("Markdown code copying", () => {
  it("shows no failure feedback before an attempt", () => {
    setClipboard(undefined);
    render(<ProductMarkdown content={content} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy code block" }).disabled).toBe(false);
    expect(screen.queryByText(failureMessage)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([undefined, {}])("reports unavailable clipboard writing (%j) and recovers on retry", async (clipboard) => {
    setClipboard(clipboard);
    const { first, second } = renderCodeBlocks();
    const button = within(first).getByRole("button", { name: "Copy code block" });
    await clickCopy(button);
    expectFailure(first);
    expect.soft(second.textContent).not.toMatch(failureMessage);
    expect.soft(within(second).queryByRole("button", { name: "Copy code block" })).not.toBeNull();

    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await clickCopy(button);
    expect(writeText.mock.calls).toEqual([[code]]);
    expect(within(first).getByRole("button", { name: "Copied code block" })).toBe(button);
    expect(first.textContent).not.toMatch(failureMessage);
    expect(within(second).getByRole("button", { name: "Copy code block" })).toBeTruthy();
  });

  it("handles a controlled rejection without success or unhandled rejection and retries exact text", async () => {
    let rejectWrite!: (reason: Error) => void;
    const pendingWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writeText = vi.fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(pendingWrite)
      .mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { first, second } = renderCodeBlocks();
    const button = within(first).getByRole("button", { name: "Copy code block" });
    await clickCopy(button);
    expect(writeText.mock.calls).toEqual([[code]]);
    expect(within(first).queryByRole("button", { name: "Copied code block" })).toBeNull();
    await act(async () => {
      rejectWrite(new Error("Clipboard write denied"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expectFailure(first);
    expect.soft(unhandledRejections).toEqual([]);

    await clickCopy(within(second).getByRole("button", { name: "Copy code block" }));
    expectFailure(first);
    expect(within(second).getByRole("button", { name: "Copied code block" })).toBeTruthy();
    await clickCopy(button);
    expect(writeText.mock.calls).toEqual([[code], ["second block"], [code]]);
    expect(within(first).getByRole("button", { name: "Copied code block" })).toBe(button);
    expect(first.textContent).not.toMatch(failureMessage);
  });

  it("handles synchronous clipboard errors", async () => {
    const writeText = vi.fn(() => { throw new Error("Clipboard unavailable"); });
    setClipboard({ writeText });
    const { first } = renderCodeBlocks();
    await clickCopy(within(first).getByRole("button", { name: "Copy code block" }));
    expect(writeText.mock.calls).toHaveLength(1);
    expectFailure(first);
  });

  it("copies exact whitespace and retains the existing success reset", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<ProductMarkdown content={content} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code block" })); });
    expect(writeText.mock.calls).toEqual([[code]]);
    expect(screen.getByRole("button", { name: "Copied code block" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(screen.queryByText(failureMessage)).toBeNull();
  });
});
