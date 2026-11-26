import type {
  LoopMissedPolicy,
  LoopOverlapPolicy,
  LoopRejectionReason,
  LoopSource,
} from "./cloud-loop-contract";

export const loopSourceLabels: Record<LoopSource, string> = {
  webhook: "Webhook",
  email: "Email",
  github: "GitHub",
  gitlab: "GitLab",
  sentry: "Sentry",
  grafana: "Grafana",
  teams: "Teams",
  slack: "Slack",
};

export const rejectionLabels: Record<LoopRejectionReason, string> = {
  source_disabled: "Source is off",
  invalid_secret: "Invalid secret",
  untrusted: "Not trusted by the automation",
  loops_disabled: "Automations are off",
  killed: "Automation is killed",
};

export const overlapLabels: Record<LoopOverlapPolicy, string> = {
  allow: "Run in parallel",
  skip: "Skip the new run",
  queue: "Queue the new run",
  cancel_previous: "Cancel the running one",
};

export const missedLabels: Record<LoopMissedPolicy, string> = {
  skip: "Skip",
  latest: "Run the latest once",
};

export function centsToDollars(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

export function dollarsToCents(dollars: string): number | null {
  const text = dollars.trim();
  if (!text) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents < 1)
    throw new Error("Enter a budget of at least $0.01.");
  return cents;
}
