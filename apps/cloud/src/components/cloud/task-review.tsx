import {
  CircleAlert,
  CircleCheck,
  Lightbulb,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type {
  DeliveryGate,
  ReviewFinding,
  RunReview,
} from "@machdoch/fleet-protocol/cloud-delivery";
import { Timestamp } from "./timestamp";

export const gateLabels: Record<DeliveryGate["id"], string> = {
  checks: "Checks",
  tests_intact: "Tests intact",
  protected_paths: "Sensitive areas",
  change_size: "Change size",
};

export function ReviewFindingItem({ finding }: { finding: ReviewFinding }) {
  const Icon = finding.severity === "blocking" ? CircleAlert : Lightbulb;
  return (
    <li className="cloud-review-finding" data-severity={finding.severity}>
      <Icon size={15} aria-hidden="true" />
      <div>
        <strong>{finding.title}</strong>
        {finding.file && (
          <code>
            {finding.file}
            {finding.line ? `:${finding.line}` : ""}
          </code>
        )}
        {finding.detail && <p>{finding.detail}</p>}
      </div>
    </li>
  );
}

export function TaskGates({ gates }: { gates: DeliveryGate[] }) {
  return (
    <ul className="cloud-review-gates" aria-label="Merge rules">
      {gates.map((gate) => (
        <li key={gate.id} data-passed={gate.passed}>
          {gate.passed ? (
            <CircleCheck size={15} aria-hidden="true" />
          ) : (
            <TriangleAlert size={15} aria-hidden="true" />
          )}
          <div>
            <strong>{gateLabels[gate.id]}</strong>
            <span>{gate.detail}</span>
            {gate.paths.length > 0 && (
              <span className="cloud-review-paths">
                {gate.paths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TaskReview({ reviews }: { reviews: RunReview[] }) {
  if (!reviews.length)
    return (
      <div className="cloud-empty">
        <ShieldCheck aria-hidden="true" />
        <p>The AI review starts after the checks pass.</p>
      </div>
    );
  const latest = reviews.at(-1)!;
  return (
    <div className="cloud-task-report">
      <section className="cloud-card">
        <h2>
          <ShieldCheck size={17} aria-hidden="true" />
          Merge rules
        </h2>
        <TaskGates gates={latest.gates} />
      </section>
      {[...reviews].reverse().map((review) => {
        const blocking = review.findings.filter(
          (finding) => finding.severity === "blocking",
        );
        const suggestions = review.findings.filter(
          (finding) => finding.severity === "suggestion",
        );
        return (
          <section
            className="cloud-card cloud-review-round"
            key={review.id}
            data-decision={review.decision}
          >
            <header>
              <h2>Round {review.round}</h2>
              <span
                className="cloud-task-state"
                data-state={
                  review.decision === "approve" ? "succeeded" : "running"
                }
              >
                {review.decision === "approve"
                  ? "Approved"
                  : `${blocking.length} ${blocking.length === 1 ? "change" : "changes"} requested`}
              </span>
              <span className="cloud-review-meta">
                {review.model} · <Timestamp value={review.createdAt} /> ·{" "}
                <code>{review.candidateCommit.slice(0, 7)}</code>
              </span>
            </header>
            <p>{review.summary}</p>
            {blocking.length > 0 && (
              <ul className="cloud-review-findings">
                {blocking.map((finding, index) => (
                  <ReviewFindingItem key={index} finding={finding} />
                ))}
              </ul>
            )}
            {suggestions.length > 0 && (
              <details className="cloud-review-suggestions">
                <summary>
                  {suggestions.length}{" "}
                  {suggestions.length === 1 ? "suggestion" : "suggestions"}
                </summary>
                <ul className="cloud-review-findings">
                  {suggestions.map((finding, index) => (
                    <ReviewFindingItem key={index} finding={finding} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}
