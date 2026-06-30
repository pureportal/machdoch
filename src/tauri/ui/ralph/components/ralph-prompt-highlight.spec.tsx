import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RalphPromptHighlight } from "./ralph-prompt-highlight";

describe("RalphPromptHighlight", () => {
  it("renders plain prompt text unchanged", () => {
    render(<RalphPromptHighlight value="Review the selected source files." />);

    expect(screen.getByText("Review the selected source files.")).toBeTruthy();
  });

  it("highlights Ralph placeholder tokens while preserving surrounding text", () => {
    const { container } = render(
      <p>
        <RalphPromptHighlight value="Refactor {{scope:path=src}} with {{cycle}}" />
      </p>,
    );

    expect(container.textContent).toBe("Refactor {{scope:path=src}} with {{cycle}}");
    expect(screen.getByText("{{scope:path=src}}").className).toContain("text-emerald-200");
    expect(screen.getByText("{{cycle}}").className).toContain("text-emerald-200");
  });
});
