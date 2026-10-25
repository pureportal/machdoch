import { z } from "zod";

const token = z.string().min(1).max(200);
const workspaceRoot = z.string().trim().min(1).max(12000);
export const cloudWorkspaceRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), refresh: z.boolean() }),
  z.strictObject({
    action: z.literal("connect"),
    origin: z.url().max(2048),
    token,
    workspaceRoot,
    name: z.string().trim().min(1).max(120),
  }),
  z.strictObject({
    action: z.literal("reconnect"),
    id: z.uuid(),
    token: token.optional(),
  }),
  z.strictObject({
    action: z.literal("disconnect"),
    id: z.uuid(),
    token: token.optional(),
  }),
]);
export type CloudWorkspaceRequest = z.infer<typeof cloudWorkspaceRequestSchema>;
export const cloudWorkspaceViewSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  origin: z.url(),
  workspaceRoot,
  workspaceName: z.string().min(1).max(120),
  projectName: z.string().min(1).max(120),
  profileName: z.string().min(1).max(120),
  status: z.enum(["linking", "linked", "disconnecting", "disconnected"]),
  access: z.enum([
    "unchecked",
    "available",
    "ended",
    "credentials_required",
    "unreachable",
  ]),
});
export type CloudWorkspaceView = z.infer<typeof cloudWorkspaceViewSchema>;
export const cloudWorkspaceReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    connections: z.array(cloudWorkspaceViewSchema).max(100),
  }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(2000) }),
]);
export type CloudWorkspaceReply = z.infer<typeof cloudWorkspaceReplySchema>;
