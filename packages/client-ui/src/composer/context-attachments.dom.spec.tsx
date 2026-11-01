import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { ContextAttachmentsList } from "./context-attachments";
import type { ChatSessionContextAttachment } from "./model";

afterEach(cleanup);

const image = {
  id: "image",
  kind: "image",
  name: "screenshot.png",
  path: "C:/fixture/screenshot.png",
} as ChatSessionContextAttachment;
const file = {
  id: "file",
  kind: "file",
  name: "report.txt",
  path: "C:/fixture/report.txt",
} as ChatSessionContextAttachment;

const renderList = (attachments: ChatSessionContextAttachment[]) =>
  render(
    <TooltipProvider>
      <ContextAttachmentsList
        attachments={attachments}
        onRemove={() => {}}
        onClearAll={() => {}}
      />
    </TooltipProvider>,
  );

const clearAll = () =>
  screen.queryByRole("button", { name: "Remove all attached context" });

it("leaves removal of a single attachment to its own button", () => {
  renderList([image]);
  expect(clearAll()).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove screenshot.png" }),
  ).toBeTruthy();
});

it("offers clearing once several attachments are present", () => {
  renderList([image, file]);
  expect(clearAll()).not.toBeNull();
});

it("labels the kind only where the icon alone is not enough", () => {
  renderList([image, file]);
  expect(screen.queryByText("image")).toBeNull();
  expect(screen.getByText("file")).toBeTruthy();
});
