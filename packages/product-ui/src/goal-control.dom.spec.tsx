import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalControl } from "./goal-control";

afterEach(cleanup);

describe("goal control", () => {
  it.each([
    "All auth tests pass",
    "clear",
    "mode native",
    "--tokens 10 Fix auth",
  ])(
    "starts the literal objective %s and selects its execution mode",
    (objective) => {
      const onCommand = vi.fn();
      const onModeChange = vi.fn();
      render(
        <GoalControl
          mode="machdoch"
          modes={["machdoch", "native"]}
          running={false}
          onModeChange={onModeChange}
          onCommand={onCommand}
          onPause={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Goal" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Goal mode" }), {
        target: { value: "native" },
      });
      expect(onModeChange).toHaveBeenCalledWith("native");
      fireEvent.change(
        screen.getByRole("textbox", { name: "Goal objective" }),
        {
          target: { value: objective },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
      expect(onCommand).toHaveBeenCalledWith(`/goal -- ${objective}`);
    },
  );
  it("offers pause while active and resume after an interruption", () => {
    const onPause = vi.fn();
    const onCommand = vi.fn();
    const goal = {
      id: "goal",
      objective: "All tests pass",
      mode: "machdoch" as const,
      status: "active" as const,
      turns: 2,
      tokensUsed: 120,
      elapsedMs: 100,
      reason: "",
      createdAt: 1,
      updatedAt: 1,
    };
    const props = {
      mode: "machdoch" as const,
      modes: ["machdoch" as const],
      goal,
      onPause,
      onCommand,
      onModeChange: vi.fn(),
    };
    const view = render(<GoalControl {...props} running />);
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    expect(screen.queryByRole("button", { name: "Start goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(onPause).toHaveBeenCalledOnce();
    view.rerender(<GoalControl {...props} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    expect(onCommand).toHaveBeenCalledWith("/goal resume");
  });
  it("does not offer resume when a budget is exhausted", () => {
    const goal = {
      id: "goal",
      objective: "All tests pass",
      mode: "machdoch" as const,
      status: "budget-limited" as const,
      turns: 2,
      tokensUsed: 120,
      elapsedMs: 100,
      reason: "Turn limit reached.",
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <GoalControl
        mode="machdoch"
        modes={["machdoch"]}
        goal={goal}
        running={false}
        onModeChange={vi.fn()}
        onCommand={vi.fn()}
        onPause={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));
    expect(screen.queryByRole("button", { name: "Resume goal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear goal" })).toBeDefined();
  });
});
