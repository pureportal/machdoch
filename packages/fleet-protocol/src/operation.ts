import { z } from "zod";

export const operationReadSchema = z.strictObject({
  kind: z.literal("read"),
  id: z.string().uuid(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
});

export const operationReleaseSchema = z.strictObject({
  kind: z.literal("release"),
  id: z.string().uuid(),
});

export const operationEventsSchema = z.strictObject({
  kind: z.literal("events"),
  after: z.number().int().nonnegative(),
});

export const operationResponseSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z
    .strictObject({
      state: z.literal("complete"),
      chunk: z.string().max(262144),
      offset: z.number().int().nonnegative(),
      total: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
    })
    .refine(
      ({ chunk, offset, total }) =>
        offset <= total &&
        chunk.length <= total - offset &&
        (chunk.length > 0 || offset === total),
    ),
  z.strictObject({ state: z.literal("failed"), error: z.json() }),
  z.strictObject({
    state: z.literal("events"),
    cursor: z.number().int().nonnegative(),
    events: z
      .array(
        z.strictObject({
          name: z.enum([
            "media-import-progress",
            "media-civitai-download-progress",
            "desktop-task-progress",
          ]),
          payload: z.json(),
        }),
      )
      .max(256),
  }),
]);

export type OperationResponse = z.infer<typeof operationResponseSchema>;
