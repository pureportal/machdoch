// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBlob } from "html-to-image";
import {
  copyMessageImage,
  copyMessageText,
  createMessageMarkdownFileName,
  saveMessageMarkdown,
} from "./message-export";

vi.mock("html-to-image", () => ({ toBlob: vi.fn() }));

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

const write = vi.fn<(items: TestClipboardItem[]) => Promise<void>>();
const createBubble = (): HTMLElement => {
  const bubble = document.createElement("div");
  bubble.innerHTML =
    '<button>Read response aloud</button><div class="app-markdown"><h2>Answer</h2><div><pre><code>  code\n\tline\n</code></pre><button>Copy code</button></div><button data-workspace-path="file.ts">file.ts</button></div><p>Enhancing message</p>';
  document.body.append(bubble);
  return bubble;
};

beforeEach(() => {
  write.mockReset().mockImplementation(async (items) => {
    await items[0]!.data["image/png"];
  });
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  vi.mocked(toBlob)
    .mockReset()
    .mockResolvedValue(new Blob(["png"], { type: "image/png" }));
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("message image exports", () => {
  it("starts the clipboard write within the user gesture and captures a clean snapshot", async () => {
    const bubble = createBubble();
    const originalMarkup = bubble.innerHTML;
    let capturedText = "";
    vi.mocked(toBlob).mockImplementation(async (clone) => {
      expect(clone.isConnected).toBe(true);
      expect(clone.style.getPropertyValue("max-width")).toBe("none");
      expect(clone.style.getPropertyPriority("max-width")).toBe("important");
      capturedText = clone.textContent ?? "";
      return new Blob(["png"], { type: "image/png" });
    });
    const copy = copyMessageImage(bubble);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toBlob)).not.toHaveBeenCalled();
    await copy;
    expect(capturedText).toBe("Answer  code\n\tline\nfile.ts");
    expect(bubble.innerHTML).toBe(originalMarkup);
    expect(document.body.children).toHaveLength(1);
  });

  it("keeps the captured content when the displayed message changes", async () => {
    const bubble = createBubble();
    const copy = copyMessageImage(bubble);
    bubble.querySelector("h2")!.textContent = "New answer";
    await copy;
    expect(vi.mocked(toBlob).mock.calls[0]![0].textContent).toContain("Answer");
    expect(vi.mocked(toBlob).mock.calls[0]![0].textContent).not.toContain(
      "New answer",
    );
  });

  it("reports PNG creation failure and removes the temporary snapshot", async () => {
    const bubble = createBubble();
    vi.mocked(toBlob).mockResolvedValue(null);
    await expect(copyMessageImage(bubble)).rejects.toThrow(
      "could not be created",
    );
    expect(document.body.children).toHaveLength(1);
  });

  it("cleans up if the clipboard rejects the image synchronously", async () => {
    const bubble = createBubble();
    write.mockImplementation(() => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    await expect(copyMessageImage(bubble)).rejects.toThrow("Denied");
    expect(document.body.children).toHaveLength(1);
  });

  it("reports missing image clipboard support without rendering", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(copyMessageImage(createBubble())).rejects.toThrow(
      "Image copying is unavailable",
    );
    expect(vi.mocked(toBlob)).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports unavailable text clipboard access", async () => {
    await expect(copyMessageText("Hello")).rejects.toThrow(
      "Clipboard access is unavailable",
    );
  });
});

describe("message Markdown downloads", () => {
  it("downloads UTF-8 Markdown and keeps the URL alive until the download starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const createObjectURL = vi.fn().mockReturnValue("blob:message");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let downloaded:
      | { content: Blob; name: string; connected: boolean }
      | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloaded = {
          content: createObjectURL.mock.calls[0]![0],
          name: this.download,
          connected: this.isConnected,
        };
      },
    );
    saveMessageMarkdown("# Café\n\n**Answer**", "message.md");
    expect(downloaded?.name).toBe("message.md");
    expect(downloaded?.connected).toBe(true);
    expect(downloaded?.content.type).toBe("text/markdown;charset=utf-8");
    const content = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloaded!.content);
    });
    expect(content).toBe("# Café\n\n**Answer**");
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:message");
  });

  it("names downloads by role and creation time", () => {
    expect(
      createMessageMarkdownFileName({
        id: "message",
        role: "agent",
        content: "Hello",
        createdAt: 0,
      }),
    ).toBe("machdoch-assistant-message-1970-01-01T00-00-00-000Z.md");
    expect(
      createMessageMarkdownFileName({
        id: "User / Message",
        role: "user",
        content: "Hello",
      }),
    ).toBe("machdoch-user-message-user-message.md");
  });
});
