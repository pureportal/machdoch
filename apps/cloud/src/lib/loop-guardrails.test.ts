import { describe, expect, it } from "vitest";
import {
  admitLoopRun,
  consequentialActionKinds,
  exceedsRunBudget,
  loopCostCents,
  missedRunsToStart,
  shouldPauseLoop,
  type LoopAdmissionInput,
} from "./loop-guardrails";

const base: LoopAdmissionInput = {
  automationId: "a",
  dryRun: false,
  loopsEnabled: true,
  killed: false,
  chainAutomationIds: [],
  dailyUsed: 0,
  dailyLimit: 10,
  overlap: "allow",
  activeRuns: 0,
  runBudgetCents: null,
  runBudgetCapCents: null,
  monthBudgetCents: null,
  monthBudgetCapCents: null,
  loopMonthCents: 0,
  workspaceMonthCents: 0,
};

describe("loop guardrails", () => {
  it("reserves the tightest run budget before the run starts and rejects runs past the month budget", () => {
    expect(
      admitLoopRun({ ...base, runBudgetCents: 50, runBudgetCapCents: 30 }),
    ).toEqual({ admitted: true, reservedCents: 30, cancelActive: false });
    expect(
      admitLoopRun({
        ...base,
        runBudgetCents: 50,
        monthBudgetCents: 100,
        loopMonthCents: 60,
      }),
    ).toMatchObject({ admitted: false, code: "month_budget" });
    expect(
      admitLoopRun({
        ...base,
        monthBudgetCapCents: 100,
        workspaceMonthCents: 100,
      }),
    ).toMatchObject({ admitted: false, code: "month_budget" });
    expect(exceedsRunBudget(31, 30)).toBe(true);
    expect(exceedsRunBudget(30, 30)).toBe(false);
    expect(exceedsRunBudget(1_000, null)).toBe(false);
    expect(loopCostCents(1_500, 2)).toBe(3);
  });

  it("applies the overlap policy", () => {
    expect(
      admitLoopRun({ ...base, overlap: "skip", activeRuns: 1 }),
    ).toMatchObject({ admitted: false, code: "overlap" });
    expect(
      admitLoopRun({ ...base, overlap: "cancel_previous", activeRuns: 1 }),
    ).toMatchObject({ admitted: true, cancelActive: true });
    expect(
      admitLoopRun({ ...base, overlap: "allow", activeRuns: 3 }),
    ).toMatchObject({ admitted: true, cancelActive: false });
  });

  it("starts at most one missed run and drops late runs when missed runs are skipped", () => {
    const due = new Date("2026-01-01T10:00:00Z");
    const late = new Date("2026-01-01T11:00:00Z");
    const grace = 5 * 60_000;
    expect(missedRunsToStart("latest", due, late, grace)).toBe(1);
    expect(missedRunsToStart("skip", due, late, grace)).toBe(0);
    expect(
      missedRunsToStart("skip", due, new Date("2026-01-01T10:01:00Z"), grace),
    ).toBe(1);
    expect(
      missedRunsToStart("latest", due, new Date("2026-01-01T09:00:00Z"), grace),
    ).toBe(0);
  });

  it("blocks a loop that already ran earlier in the same chain", () => {
    expect(
      admitLoopRun({ ...base, chainAutomationIds: ["b", "a"] }),
    ).toMatchObject({ admitted: false, code: "chain_loop" });
    expect(
      admitLoopRun({ ...base, chainAutomationIds: ["b"] }),
    ).toMatchObject({ admitted: true });
  });

  it("honors the kill switch, the workspace switch and the daily limit, and lets dry runs skip spend checks", () => {
    expect(admitLoopRun({ ...base, killed: true })).toMatchObject({
      admitted: false,
      code: "killed",
    });
    expect(admitLoopRun({ ...base, loopsEnabled: false })).toMatchObject({
      admitted: false,
      code: "loops_disabled",
    });
    expect(admitLoopRun({ ...base, dailyUsed: 10 })).toMatchObject({
      admitted: false,
      code: "daily_limit",
    });
    expect(
      admitLoopRun({
        ...base,
        dryRun: true,
        dailyUsed: 10,
        monthBudgetCents: 1,
        loopMonthCents: 5,
      }),
    ).toEqual({ admitted: true, reservedCents: 0, cancelActive: false });
    expect(admitLoopRun({ ...base, dryRun: true, killed: true })).toMatchObject(
      { admitted: false, code: "killed" },
    );
  });

  it("pauses after N failures in a row and marks consequential outputs for approval", () => {
    expect(shouldPauseLoop(2, 3)).toBe(false);
    expect(shouldPauseLoop(3, 3)).toBe(true);
    expect(shouldPauseLoop(50, null)).toBe(false);
    for (const kind of [
      "comment",
      "create_issue",
      "append_document_section",
      "notify",
      "send_webhook",
      "write_project_updates",
    ])
      expect(consequentialActionKinds.has(kind)).toBe(true);
    for (const kind of ["ask_agent", "remember", "request_input", "goal"])
      expect(consequentialActionKinds.has(kind)).toBe(false);
  });
});
