import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RalphCopyButton } from "./ralph-copy-button";

describe("RalphCopyButton", () => {
  it("copies the supplied run output and confirms success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <RalphCopyButton
        value="Run completed with three changed files."
        label="run summary"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy run summary" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Run completed with three changed files.",
      );
    });
    expect(
      screen.getByRole("button", { name: "run summary copied" }),
    ).toBeTruthy();
  });
});
