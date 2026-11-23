import { z } from "zod";
import { cloudId, issuePriorities } from "./cloud-contract";

export const slaStates = ["breached", "at_risk", "ok", "none"] as const;
export type SlaState = (typeof slaStates)[number];
export const slaStateLabels: Record<SlaState, string> = {
  breached: "Breached",
  at_risk: "At risk",
  ok: "On track",
  none: "No SLA",
};
export const slaAtRiskHours = 24;
export const slaPriorities = issuePriorities.filter(
  (priority) => priority !== "none",
);

export const slaPolicyInputSchema = z
  .strictObject({
    teamId: cloudId,
    priority: z.enum(slaPriorities).nullable(),
    labelId: cloudId.nullable(),
    hours: z.number().int().min(1).max(8760),
  })
  .refine((input) => input.priority !== null || input.labelId !== null, {
    message: "Choose a priority or a label.",
  });
export type SlaPolicyInput = z.infer<typeof slaPolicyInputSchema>;
export const slaPolicyUpdateSchema = z.strictObject({
  hours: z.number().int().min(1).max(8760),
});

export interface CloudSlaPolicy {
  id: string;
  teamId: string;
  priority: (typeof slaPriorities)[number] | null;
  labelId: string | null;
  labelName: string | null;
  hours: number;
}

const hourMs = 3_600_000;

export function slaState(dueAt: string | null, now: Date): SlaState {
  if (!dueAt) return "none";
  const remaining = Date.parse(dueAt) - now.getTime();
  if (remaining <= 0) return "breached";
  return remaining <= slaAtRiskHours * hourMs ? "at_risk" : "ok";
}

export function slaTimeLeft(dueAt: string, now: Date): string {
  const remaining = Date.parse(dueAt) - now.getTime();
  if (remaining <= 0) return slaStateLabels.breached;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function slaDuration(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}
