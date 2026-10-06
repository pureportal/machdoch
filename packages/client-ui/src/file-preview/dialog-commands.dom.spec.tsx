import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { FilePreviewDialog } from "./dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps closed composer and conversation previews from disabling each other's commands", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const changed = vi.fn();
  render(
    <CommandProvider activeView="chat">
      <FilePreviewDialog preview={null} onOpenChange={changed} onOpenExternal={vi.fn()} />
      <FilePreviewDialog preview={null} onOpenChange={changed} onOpenExternal={vi.fn()} />
    </CommandProvider>,
  );
  await waitFor(() => expect(error).not.toHaveBeenCalledWith(
    expect.stringContaining("Duplicate command IDs were disabled"),
  ));
});
