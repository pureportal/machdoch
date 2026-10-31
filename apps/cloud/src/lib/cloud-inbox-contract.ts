import { z } from "zod";
import type { RunState } from "@machdoch/fleet-protocol/cloud-execution";
import { cloudId } from "./cloud-contract";

export const inboxKinds = [
  "assigned",
  "commented",
  "mentioned",
  "task_finished",
] as const;
export type InboxKind = (typeof inboxKinds)[number];

export const inboxUpdateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read"),
    ids: z.array(cloudId).min(1).max(100),
    read: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("read-all") }),
  z.strictObject({
    kind: z.literal("dismiss"),
    ids: z.array(cloudId).min(1).max(100),
  }),
]);
export type InboxUpdate = z.infer<typeof inboxUpdateSchema>;

export interface InboxEntry {
  id: string;
  kind: InboxKind;
  detail: string;
  read: boolean;
  createdAt: string;
  actor: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueState: string | null;
  runId: string | null;
  runTitle: string | null;
  runState: RunState | null;
}
