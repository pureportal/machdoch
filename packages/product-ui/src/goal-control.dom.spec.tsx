import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { GoalControl as GoalControlView, GoalTrigger } from "./goal-control";
import { useGoalDraft } from "./use-goal-draft";

function GoalControl(
  props: Omit<
    ComponentProps<typeof GoalControlView>,
    "objective" | "onObjectiveChange"
  >,
) {
  const draft = useGoalDraft("session", props.goal, props.open, props.running);
  return (
    <GoalControlView
      {...props}
      objective={draft.objective}
      onObjectiveChange={draft.setObjective}
    />
  );
}

afterEach(cleanup);

describe("goal control", () => {
  it("shows native availability for a provider with only managed goals", () => {
    render(
      <GoalControl
        id="goal-input"
        open
        mode="machdoch"
        modes={["machdoch"]}
        running={false}
        onClose={vi.fn()}
        onModeChange={vi.fn()}
        onCommand={vi.fn()}
        onPause={vi.fn()}
      />,
    );
    const mode = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Goal mode",
    });
    expect(mode.value).toBe("machdoch");
    expect(
      screen.getByRole<HTMLOptionElement>("option", {
        name: "Native (unavailable)",
      }).disabled,
    ).toBe(true);
  });
  it("starts in the newly selected mode instead of resuming the saved mode", () => {
    const onCommand = vi.fn();
    render(
      <GoalControl
        id="goal-input"
        open
        mode="native"
        modes={["machdoch", "native"]}
        goal={{
          id: "goal",
          objective: "Fix auth",
          mode: "machdoch",
          status: "blocked",
          turns: 1,
          tokensUsed: 10,
          elapsedMs: 1,
          reason: "Previous blocker",
          createdAt: 1,
          updatedAt: 1,
        }}
        running={false}
        onClose={vi.fn()}
        onModeChange={vi.fn()}
        onCommand={onCommand}
        onPause={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resume goal" })).toBeNull();
    expect(screen.queryByText("Previous blocker")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    expect(onCommand).toHaveBeenCalledWith("/goal -- Fix auth");
  });
  it("highlights an enabled goal and keeps a running goal highlighted when hidden", () => {
    const props = {
      open: true,
      controls: "goal-input",
      onClick: vi.fn(),
    };
    const view = render(<GoalTrigger {...props} active={false} />);
    const trigger = screen.getByRole("button", { name: "Goal" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
    expect(trigger.getAttribute("data-active")).toBe("true");
    view.rerender(<GoalTrigger {...props} open={false} active={false} />);
    expect(trigger.getAttribute("aria-pressed")).toBe("false");
    expect(trigger.getAttribute("data-active")).toBe("false");
    view.rerender(<GoalTrigger {...props} open={false} active />);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-active")).toBe("true");
  });

  it("identifies an unstarted draft and explains why starting is disabled", () => {
    const props = {
      id: "goal-input",
      open: true,
      mode: "machdoch" as const,
      modes: ["machdoch" as const],
      onClose: vi.fn(),
      onModeChange: vi.fn(),
      onCommand: vi.fn(),
      onPause: vi.fn(),
    };
    const view = render(<GoalControl {...props} running={false} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
      target: { value: "Fix auth" },
    });
    expect(screen.getByRole("status").textContent).toBe("Not started");
    expect(props.onCommand).not.toHaveBeenCalled();

    view.rerender(<GoalControl {...props} running />);
    const start = screen.getByRole<HTMLButtonElement>("button", {
      name: "Start goal",
    });
    expect(start.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Not started");
    expect(
      document.getElementById(start.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Finish or stop the current task first.");
    fireEvent.click(start);
    expect(props.onCommand).not.toHaveBeenCalled();

    view.rerender(<GoalControl {...props} running={false} />);
    expect(start.disabled).toBe(false);
    expect(start.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(start);
    expect(props.onCommand).toHaveBeenCalledExactlyOnceWith(
      "/goal -- Fix auth",
    );
  });

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
          id="goal-input"
          open
          onClose={vi.fn()}
          mode="machdoch"
          modes={["machdoch", "native"]}
          running={false}
          onModeChange={onModeChange}
          onCommand={onCommand}
          onPause={vi.fn()}
        />,
      );
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
      id: "goal-input",
      open: true,
      onClose: vi.fn(),
      mode: "machdoch" as const,
      modes: ["machdoch" as const],
      goal,
      onPause,
      onCommand,
      onModeChange: vi.fn(),
    };
    const view = render(<GoalControl {...props} running />);
    expect(screen.getByRole("status").textContent).toBe("Active");
    expect(
      screen.queryByText("Finish or stop the current task first."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Start goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    expect(onPause).toHaveBeenCalledOnce();
    view.rerender(<GoalControl {...props} running={false} />);
    expect(screen.getByRole("status").textContent).toBe("Paused");
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
        id="goal-input"
        open
        onClose={vi.fn()}
        mode="machdoch"
        modes={["machdoch"]}
        goal={goal}
        running={false}
        onModeChange={vi.fn()}
        onCommand={vi.fn()}
        onPause={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Resume goal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear goal" })).toBeDefined();
  });

  it("keeps a multiline draft when hidden and reopened", () => {
    const props = {
      id: "goal-input",
      mode: "machdoch" as const,
      modes: ["machdoch" as const],
      running: false,
      onClose: vi.fn(),
      onModeChange: vi.fn(),
      onCommand: vi.fn(),
      onPause: vi.fn(),
    };
    const view = render(<GoalControl {...props} open />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Goal objective",
    });
    fireEvent.change(input, { target: { value: "Fix auth\nVerify sign-in" } });
    view.rerender(<GoalControl {...props} open={false} />);
    expect(
      screen.queryByRole("textbox", { name: "Goal objective" }),
    ).toBeNull();
    view.rerender(<GoalControl {...props} open />);
    expect(input.value).toBe("Fix auth\nVerify sign-in");
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    expect(props.onCommand).toHaveBeenCalledWith(
      "/goal -- Fix auth\nVerify sign-in",
    );
  });

  it("starts an edited objective instead of resuming the saved goal", () => {
    const onCommand = vi.fn();
    render(
      <GoalControl
        id="goal-input"
        open
        mode="machdoch"
        modes={["machdoch"]}
        goal={{
          id: "goal",
          objective: "Fix auth",
          mode: "machdoch",
          status: "paused",
          turns: 2,
          tokensUsed: 120,
          elapsedMs: 100,
          reason: "",
          createdAt: 1,
          updatedAt: 1,
        }}
        running={false}
        onClose={vi.fn()}
        onModeChange={vi.fn()}
        onCommand={onCommand}
        onPause={vi.fn()}
      />,
    );
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Goal objective",
    });
    expect(input.value).toBe("Fix auth");
    fireEvent.change(input, {
      target: { value: "Fix auth and verify sign-out" },
    });
    expect(screen.getByRole("status").textContent).toBe("Not started");
    expect(screen.queryByRole("button", { name: "Resume goal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    expect(onCommand).toHaveBeenCalledWith(
      "/goal -- Fix auth and verify sign-out",
    );
  });
});
