import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductMarkdown } from "./markdown";

const content = "```js\nconst status = 'ready';\n```";
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("markdown snapshot refreshes", () => {
  it.each([true, false])(
    "preserves code blocks and copy feedback when content is unchanged (success: %s)",
    async (succeeds) => {
      const writeText = vi.fn(() =>
        succeeds
          ? Promise.resolve()
          : Promise.reject(new Error("Clipboard denied")),
      );
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const view = render(<ProductMarkdown content={content} />);
      const button = screen.getByRole("button", { name: "Copy code block" });
      await act(async () => {
        fireEvent.click(button);
      });
      view.rerender(<ProductMarkdown content={content} />);
      expect(button.isConnected).toBe(true);
      if (succeeds)
        expect(screen.getByRole("button", { name: "Copied code block" })).toBe(
          button,
        );
      else
        expect(screen.getByRole("alert").textContent).toContain(
          "Could not copy.",
        );
      expect(writeText).toHaveBeenCalledOnce();
    },
  );
});
