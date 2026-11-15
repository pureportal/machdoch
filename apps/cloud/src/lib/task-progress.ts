import {
  maximumReviewRounds,
  type RunReview,
} from "@machdoch/fleet-protocol/cloud-delivery";
import {
  isPullRequestCheck,
  type RunDetail,
} from "@machdoch/fleet-protocol/cloud-execution";

export type StageStatus = "done" | "current" | "failed" | "waiting" | "skipped";
export type StageId =
  | "queued"
  | "implement"
  | "verify"
  | "review"
  | "publish"
  | "merge";

export interface TaskStage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail: string;
}

export type OutcomeTone = "success" | "progress" | "attention" | "danger";
export type OutcomeAction = "merge" | "publish";

export interface TaskOutcome {
  tone: OutcomeTone;
  title: string;
  detail: string | null;
  actions: OutcomeAction[];
}

const working = new Set(["preparing", "running"]);
const ended = new Set(["failed", "canceled", "timed_out"]);

function checkCounts(run: RunDetail) {
  const start = run.timeline.findLastIndex(
    (entry) => entry.title === "Validating in a fresh VM",
  );
  const latest = run.timeline
    .slice(start + 1)
    .filter(
      (entry) =>
        entry.kind === "activity" &&
        /^Check .+ (passed|failed)$/.test(entry.title),
    );
  const passed = latest.filter((entry) => entry.status === "passed").length;
  return { passed, failed: latest.length - passed };
}

function latestReview(run: RunDetail): RunReview | null {
  return run.reviews.at(-1) ?? null;
}

function reviewing(run: RunDetail): boolean {
  const started = run.timeline.filter(
    (entry) =>
      entry.kind === "activity" &&
      /^Review round \d+ started$/.test(entry.title),
  ).length;
  return run.state === "validating" && started > run.reviews.length;
}

export function taskStages(run: RunDetail): TaskStage[] {
  const delivery = run.delivery;
  const check = isPullRequestCheck(run.manifest.subject);
  const review = latestReview(run);
  const reviewed = review?.decision === "approve";
  const usesReview = run.manifest.provider !== null;
  const failedEarly = ended.has(run.state) && !run.candidateCommit;
  const checks = checkCounts(run);
  const verifying =
    run.state === "validating" && !reviewing(run) && run.reviews.length === 0;
  const pastImplement =
    run.state === "validating" ||
    run.state === "publishing" ||
    run.state === "succeeded" ||
    !!run.candidateCommit;
  const stages: TaskStage[] = [
    {
      id: "queued",
      label: "Queued",
      status: run.state === "queued" ? "current" : "done",
      detail:
        run.state === "queued" ? "Waiting for a runner" : "Runner assigned",
    },
    {
      id: "implement",
      label: check ? "Inspect" : "Implement",
      status: failedEarly
        ? "failed"
        : working.has(run.state)
          ? "current"
          : pastImplement
            ? "done"
            : "waiting",
      detail: working.has(run.state)
        ? check
          ? "AI is checking the pull request"
          : "AI is changing the code"
        : failedEarly
          ? "Stopped before a change was ready"
          : pastImplement
            ? check
              ? "Inspected"
              : `${run.changes.length} ${run.changes.length === 1 ? "file" : "files"} changed`
            : "",
    },
    {
      id: "verify",
      label: "Checks",
      status: verifying
        ? "current"
        : checks.failed && !run.reviews.length && ended.has(run.state)
          ? "failed"
          : run.reviews.length || run.state === "succeeded"
            ? "done"
            : "waiting",
      detail: run.manifest.profile.requiredChecks.length
        ? checks.passed || checks.failed
          ? `${checks.passed} passed${checks.failed ? `, ${checks.failed} failed` : ""}`
          : `${run.manifest.profile.requiredChecks.length} to run`
        : "None configured",
    },
    {
      id: "review",
      label: "AI review",
      status: !usesReview
        ? "skipped"
        : reviewed
          ? "done"
          : reviewing(run) || (run.state === "validating" && run.reviews.length)
            ? "current"
            : review && run.state === "succeeded"
              ? "failed"
              : "waiting",
      detail: !usesReview
        ? "Not available for this runner"
        : review
          ? check
            ? reviewed
              ? "No problems found"
              : "Problems flagged"
            : reviewed
              ? `Approved in round ${review.round}`
              : `Round ${review.round} of ${maximumReviewRounds}: changes requested`
          : reviewing(run)
            ? "Reviewing"
            : "",
    },
    {
      id: "publish",
      label: "Pull request",
      status: !delivery
        ? run.state === "succeeded" && run.issueId
          ? "current"
          : "waiting"
        : delivery.state === "publishing"
          ? "current"
          : delivery.state === "failed" ||
              (delivery.state === "needs_person" && !delivery.pullRequestNumber)
            ? "failed"
            : delivery.pullRequestNumber
              ? "done"
              : "skipped",
      detail: delivery?.pullRequestNumber
        ? `#${delivery.pullRequestNumber} into ${delivery.baseBranch}`
        : delivery?.state === "publishing"
          ? "Pushing the branch"
          : "",
    },
    {
      id: "merge",
      label: "Merge",
      status: !delivery
        ? "waiting"
        : delivery.state === "merged"
          ? "done"
          : delivery.state === "merging"
            ? "current"
            : delivery.state === "closed"
              ? "skipped"
              : "waiting",
      detail:
        delivery?.state === "merged"
          ? `Merged into ${delivery.baseBranch}`
          : delivery?.state === "merging"
            ? "Waiting for repository checks"
            : delivery?.state === "closed"
              ? "Closed"
              : delivery?.pullRequestNumber
                ? "Needs your approval"
                : "",
    },
  ];
  if (!check) return stages;
  return stages
    .filter((stage) => stage.id !== "merge")
    .map((stage) =>
      stage.id === "publish"
        ? {
            ...stage,
            label: "Report",
            status:
              delivery?.state === "reported"
                ? "done"
                : delivery?.state === "failed"
                  ? "failed"
                  : delivery || run.state === "succeeded"
                    ? "current"
                    : "waiting",
            detail: delivery?.pullRequestNumber
              ? `Posted to #${delivery.pullRequestNumber}`
              : "",
          }
        : stage,
    );
}

export function taskOutcome(run: RunDetail): TaskOutcome {
  const delivery = run.delivery;
  const review = latestReview(run);
  if (delivery?.kind === "check" && delivery.state === "reported")
    return {
      tone: delivery.reason?.startsWith("No problems")
        ? "success"
        : "attention",
      title: (delivery.reason ?? "Checked").replace(/\.$/, ""),
      detail: `The result was posted to pull request #${delivery.pullRequestNumber}.`,
      actions: [],
    };
  if (
    isPullRequestCheck(run.manifest.subject) &&
    run.state === "succeeded" &&
    delivery?.state !== "failed"
  )
    return {
      tone: "progress",
      title: "Posting the result to the pull request",
      detail: null,
      actions: [],
    };
  if (delivery?.state === "merged")
    return {
      tone: "success",
      title: `Merged into ${delivery.baseBranch}`,
      detail: review ? `AI review approved it in round ${review.round}.` : null,
      actions: [],
    };
  if (delivery?.state === "merging")
    return {
      tone: "progress",
      title: "Merging when repository checks pass",
      detail: null,
      actions: [],
    };
  if (delivery?.state === "publishing")
    return {
      tone: "progress",
      title: "Opening a pull request",
      detail: delivery.reason,
      actions: [],
    };
  if (delivery?.state === "open" || delivery?.state === "needs_person")
    return delivery.pullRequestNumber
      ? {
          tone: "attention",
          title: "Ready for your review",
          detail:
            delivery.reason ??
            (delivery.autoMerge ? null : "Autopilot is off for this project."),
          actions: ["merge"],
        }
      : {
          tone: "attention",
          title: "Needs you",
          detail: delivery.reason,
          actions: ["publish"],
        };
  if (delivery?.state === "failed")
    return {
      tone: "danger",
      title: "Publishing failed",
      detail: delivery.reason,
      actions: ["publish"],
    };
  if (delivery?.state === "closed")
    return {
      tone: "attention",
      title: "Closed without merging",
      detail: delivery.reason,
      actions: [],
    };
  switch (run.state) {
    case "queued":
      return {
        tone: "progress",
        title: "Waiting for a runner",
        detail: null,
        actions: [],
      };
    case "preparing":
      return {
        tone: "progress",
        title: "Preparing a sandbox",
        detail: null,
        actions: [],
      };
    case "running":
      return {
        tone: "progress",
        title: isPullRequestCheck(run.manifest.subject)
          ? "AI is checking the pull request"
          : review
            ? `Fixing review findings from round ${review.round}`
            : "AI is working on the change",
        detail: null,
        actions: [],
      };
    case "validating":
      return {
        tone: "progress",
        title: reviewing(run)
          ? `AI review round ${run.reviews.length + 1}`
          : "Running checks in a fresh sandbox",
        detail: null,
        actions: [],
      };
    case "succeeded":
      return {
        tone: run.issueId ? "progress" : "success",
        title: run.issueId ? "Preparing the pull request" : "Done",
        detail: null,
        actions: [],
      };
    case "canceled":
      return {
        tone: "attention",
        title: "Canceled",
        detail: run.reason,
        actions: [],
      };
    default:
      return {
        tone: ended.has(run.state) ? "danger" : "progress",
        title:
          run.state === "timed_out"
            ? "Ran out of time"
            : ended.has(run.state)
              ? "The task failed"
              : "Finishing up",
        detail: run.reason ?? run.summary,
        actions: [],
      };
  }
}

export interface TaskReport {
  verdict: string | null;
  problems: string | null;
  changed: string | null;
  decisions: string | null;
  checks: string | null;
  other: string | null;
}

export function taskReport(summary: string | null): TaskReport {
  const report: TaskReport = {
    verdict: null,
    problems: null,
    changed: null,
    decisions: null,
    checks: null,
    other: null,
  };
  if (!summary?.trim()) return report;
  const sections = summary.split(/^## +/m);
  const preface = sections.shift()!.trim();
  const rest: string[] = preface ? [preface] : [];
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const heading = (newline < 0 ? section : section.slice(0, newline))
      .trim()
      .toLowerCase();
    const body = newline < 0 ? "" : section.slice(newline + 1).trim();
    if (heading === "what changed") report.changed = body;
    else if (heading === "verdict") report.verdict = body;
    else if (heading === "problems") report.problems = body;
    else if (heading === "decisions") report.decisions = body;
    else if (heading === "checks") report.checks = body;
    else rest.push(`## ${section.trim()}`);
  }
  report.other = rest.join("\n\n") || null;
  return report;
}
