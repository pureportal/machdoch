import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentLiveQuestion, AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { afterEach, expect, it, vi } from "vitest";
import { AgentLivePanel } from "./agent-live-panel";
import { AgentQuestionCard } from "./agent-question-card";
import { FollowUpSuggestions } from "./follow-up-suggestions";
import { AgentLiveRunDetails, formatQuestionAnswers } from "./agent-live-run-details";

afterEach(cleanup);

const NOW = Date.parse("2026-10-29T12:00:00Z");
const live: AgentLiveState = {
  provider: "claude-cli",
  transport: "stream-json",
  capabilities: ["steer", "interrupt", "stop-task"],
  model: "opus",
  fastMode: true,
  usage: { inputTokens: 52_900, outputTokens: 1_200, contextUsedTokens: 50_000, contextWindowTokens: 1_000_000 },
  limits: [{ id: "five-hour", label: "5-hour limit", usedPercent: 82, resetsAt: NOW + 4 * 3_600_000 }],
  plan: [
    { text: "Read the file", status: "completed" },
    { text: "Reply", status: "in_progress" },
  ],
  tasks: [
    { id: "bg-1", kind: "shell", description: "Ping localhost", summary: "Ping localhost", status: "running", background: true, canStop: true },
    { id: "bg-2", kind: "agent", description: "Explore the repo", status: "completed", background: true, canStop: false },
  ],
  fileChanges: [{ path: "src/calc.py", kind: "update", additions: 1, deletions: 1 }],
  steering: [{ id: "s1", text: "Also add tests.", status: "delivered" }],
};

it("summarises a running turn and stops background work on request", async () => {
  const onStopTask = vi.fn(async () => undefined);
  render(<AgentLivePanel live={live} running onStopTask={onStopTask} now={NOW} />);
  const panel = screen.getByRole("region", { name: /live run details/u });

  expect(within(panel).getByText("5%")).toBeTruthy();
  expect(within(panel).getByText("5-hour limit")).toBeTruthy();
  expect(within(panel).getByText(/resets in 4 h/u)).toBeTruthy();
  expect(within(panel).getByText(/Fast/u)).toBeTruthy();
  expect(within(panel).getByText("Background work")).toBeTruthy();
  expect(within(panel).getByText("Read the file")).toBeTruthy();
  expect(within(panel).getByText(/Also add tests\./u)).toBeTruthy();
  // A summary that only repeats the description is not shown twice.
  expect(within(panel).getAllByText("Ping localhost")).toHaveLength(1);

  fireEvent.click(within(panel).getByRole("button", { name: "Stop Ping localhost" }));
  await waitFor(() => expect(onStopTask).toHaveBeenCalledWith("bg-1"));
  expect(within(panel).queryByRole("button", { name: "Stop Explore the repo" })).toBeNull();
});

it("offers no stop buttons when the run cannot stop tasks", () => {
  render(<AgentLivePanel live={live} running now={NOW} />);
  expect(screen.queryByRole("button", { name: /^Stop /u })).toBeNull();
});

it("labels foreground commands apart from background work", () => {
  render(
    <AgentLivePanel
      live={{ ...live, tasks: [{ id: "c1", kind: "shell", description: "git status", status: "completed", background: false, canStop: false }] }}
      running
      now={NOW}
    />,
  );
  expect(screen.getByText("Commands & agents")).toBeTruthy();
  expect(screen.queryByText("Background work")).toBeNull();
});

const question: AgentLiveQuestion = {
  id: "q-1",
  status: "pending",
  items: [{ id: "drink", question: "Tea or coffee?", options: [{ label: "Tea" }, { label: "Coffee" }], allowOther: true }],
};

it("answers a question with a chosen option", async () => {
  const onSubmit = vi.fn(async () => undefined);
  render(<AgentQuestionCard question={question} providerLabel="Copilot CLI" onSubmit={onSubmit} />);
  const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "Coffee" }));
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ drink: "Coffee" }));
});

it("answers with typed text and shows the answered state", async () => {
  const onSubmit = vi.fn(async () => undefined);
  const view = render(<AgentQuestionCard question={question} providerLabel="Codex CLI" onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Other answer for: Tea or coffee?"), { target: { value: "Water" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ drink: "Water" }));

  view.rerender(
    <AgentQuestionCard question={{ ...question, status: "answered", answers: { drink: "Water" } }} providerLabel="Codex CLI" onSubmit={onSubmit} />,
  );
  expect(screen.getByText("You answered")).toBeTruthy();
  expect(screen.getByText("Water")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
});

it("formats answers as one message for views that answer by sending a message", () => {
  expect(formatQuestionAnswers(question, { drink: " Tea " })).toBe("Tea");
  expect(
    formatQuestionAnswers(
      {
        ...question,
        items: [
          { id: "db", header: "Database", question: "Which DB?", options: [] },
          { id: "orm", question: "Which ORM?", options: [] },
        ],
      },
      { db: "Postgres", orm: "Prisma" },
    ),
  ).toBe("Database: Postgres\nWhich ORM?: Prisma");
});

it("starts each new question with a clean selection", () => {
  const onAnswer = vi.fn(async () => undefined);
  const base = { ...live, question };
  const view = render(<AgentLiveRunDetails live={base} running onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole("radio", { name: "Coffee" }));
  expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(false);

  view.rerender(<AgentLiveRunDetails live={{ ...base, question: { ...question, id: "q-2" } }} running onAnswer={onAnswer} />);
  expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
});

it("offers to send unread steering again", () => {
  const onSendMessage = vi.fn();
  render(
    <AgentLiveRunDetails
      live={{ ...live, steering: [{ id: "s", text: "Use tabs.", status: "failed", error: "The turn ended first." }] }}
      running={false}
      onSendMessage={onSendMessage}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  expect(onSendMessage).toHaveBeenCalledWith("Use tabs.");
});

it("picks or sends a follow-up suggestion", () => {
  const onPick = vi.fn();
  const onSend = vi.fn();
  const view = render(<FollowUpSuggestions suggestions={["Add tests", "Ship it"]} onPick={onPick} onSend={onSend} />);
  fireEvent.click(screen.getByRole("button", { name: "Add tests" }));
  expect(onPick).toHaveBeenCalledWith("Add tests");
  fireEvent.click(screen.getByRole("button", { name: "Send: Ship it" }));
  expect(onSend).toHaveBeenCalledWith("Ship it");

  view.rerender(<FollowUpSuggestions suggestions={[]} onPick={onPick} />);
  expect(screen.queryByRole("group", { name: "Suggested follow-ups" })).toBeNull();
});
