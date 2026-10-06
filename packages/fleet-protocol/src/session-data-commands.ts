import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
const pageSize = z.number().int().min(1).max(80);
const fileChangePage = {
  sessionId: identifier,
  messageId: identifier,
  changeSetId: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(100),
};
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sessionDataCommands = {
  get_session_file_change_files: z.strictObject({
    ...fileChangePage,
    afterId: cursor.optional(),
  }),
  get_session_file_change_hunks: z.strictObject({
    ...fileChangePage,
    fileId: cursor.min(1),
    afterOrdinal: cursor.optional(),
  }),
  get_session_composer_text: z.strictObject({ sessionId: identifier }),
  get_session_export: z.strictObject({
    sessionIds: z.array(identifier).min(1).max(5_000),
  }),
  import_session_export: z.strictObject({
    path: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => !value.includes("\0")),
  }),
  get_session_index: z.strictObject({
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: pageSize,
    query: z.string().max(8_000),
    scope: z.enum(["all", "open", "archived"]),
    statuses: z
      .array(
        z.enum([
          "empty",
          "unread",
          "running",
          "done",
          "failed",
          "blocked",
          "cancelled",
          "timed-out",
          "unsupported",
          "crashed",
        ]),
      )
      .max(10),
    project: z.string().max(2048),
    tags: z.array(identifier).max(24),
  }),
  get_session_message_page: z.strictObject({
    sessionId: identifier,
    beforeMessageId: identifier.optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    limit: pageSize,
  }),
} as const;

export type SessionIndexQuery = z.infer<
  typeof sessionDataCommands.get_session_index
>;
export type SessionMessageQuery = z.infer<
  typeof sessionDataCommands.get_session_message_page
>;
export type SessionDataCommand = keyof typeof sessionDataCommands;
