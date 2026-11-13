import { z } from "zod";
import { cloudId } from "./cloud-contract";

export const maximumPulseProjects = 8;

export const defaultPulseInstructions = `# Pulse

Write one update per project for the team's Pulse.

## TL;DR
One sentence with the most important outcome, decision or risk. A reader who only sees the TL;DR knows whether to look closer.

## Health
- On track: the target date and scope hold.
- At risk: the target date or scope may slip; name the reason.
- Off track: the target will be missed without a change in plan.

## Body
Short Markdown sections, in this order. Leave out a section when it has nothing new.
- **Progress** – work completed since the last update, with issue IDs.
- **Next** – what the team works on next.
- **Risks** – blockers, slipping dates, open decisions.

## Style
Factual, specific and brief. Don't repeat the previous update. No greetings or sign-offs.`;

export const pulseInstructionsInputSchema = z.strictObject({
  instructions: z.string().trim().max(20_000),
});

export const pulseWriteInputSchema = z.strictObject({
  projectIds: z.array(cloudId).min(1).max(maximumPulseProjects),
  providerId: cloudId,
  model: z.string().trim().min(1).max(200),
});
export type PulseWriteInput = z.infer<typeof pulseWriteInputSchema>;

export interface PulseInstructions {
  instructions: string;
  custom: boolean;
}

export const pulseJobStates = ["waiting", "succeeded", "failed"] as const;
export type PulseJobState = (typeof pulseJobStates)[number];

export interface PulseJob {
  id: string;
  projectIds: string[];
  state: PulseJobState;
  detail: string;
  error: string | null;
  chatId: string | null;
  createdAt: string;
  finishedAt: string | null;
}
