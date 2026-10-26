import { z } from "zod";
import { revision } from "./cloud-contract";

export const commentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(20_000),
});
export const commentUpdateSchema = z.discriminatedUnion("kind", [
  commentInputSchema.extend({ kind: z.literal("edit"), revision }),
  z.strictObject({ kind: z.literal("delete"), revision }),
]);
export type CommentUpdate = z.infer<typeof commentUpdateSchema>;
export interface CloudComment {
  id: string;
  issueId: string;
  authorId: string;
  author: string;
  body: string;
  revision: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
