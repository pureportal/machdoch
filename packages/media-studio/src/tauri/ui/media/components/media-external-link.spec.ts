// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MediaExternalLink } from "./media-external-link";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("../media-platform", () => ({ openUrl }));
beforeEach(() => {
  openUrl.mockReset();
});

it("opens the download through the desktop or connected-client browser", () => {
  openUrl.mockResolvedValue(undefined);
  render(
    createElement(MediaExternalLink, {
      href: "https://huggingface.co/example/student",
      children: "Download student",
    }),
  );
  fireEvent.click(screen.getByRole("link", { name: "Download student" }));
  expect(openUrl).toHaveBeenCalledWith(
    "https://huggingface.co/example/student",
  );
});

it("shows recovery at the link if the browser cannot be opened", async () => {
  openUrl.mockRejectedValue(new Error("Browser unavailable"));
  render(
    createElement(MediaExternalLink, {
      href: "https://huggingface.co/example/LICENSE",
      children: "Licence",
    }),
  );
  fireEvent.click(screen.getByRole("link", { name: "Licence" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Copy its address",
  );
});
