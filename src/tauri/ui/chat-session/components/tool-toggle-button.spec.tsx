import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../components/ui/tooltip";
import { ToolToggleButton } from "./tool-toggle-button";

const renderToggle = (description?: string): void => {
  render(
    <TooltipProvider>
      <ToolToggleButton
        label="Global memory"
        title="Toggle global memory"
        description={description}
        icon={<span aria-hidden="true" />}
        pressed={false}
        onPressedChange={vi.fn()}
      />
    </TooltipProvider>,
  );
};

describe("ToolToggleButton", () => {
  it("does not render a native title when a custom tooltip is available", () => {
    renderToggle("Unavailable right now. Enable global memory in Settings.");

    expect(
      screen.getByRole("button", { name: "Global memory" }).getAttribute("title"),
    ).toBeNull();
  });

  it("keeps the native title when there is no custom tooltip", () => {
    renderToggle();

    expect(
      screen.getByRole("button", { name: "Global memory" }).getAttribute("title"),
    ).toBe("Toggle global memory");
  });
});
