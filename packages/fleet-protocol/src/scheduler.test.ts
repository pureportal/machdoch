import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  schedulerArgumentsSchema,
  schedulerRequestSchema,
  schedulerValueFlags,
} from "./scheduler.ts";
import { hostRequestSchema } from "./index.ts";

const invocation = (args: string[]) => ({
  kind: "invoke",
  id: "2d46f10e-c337-45bc-9a95-3f08369c3345",
  command: "run_scheduler_command",
  args: { request: { workspaceRoot: "/projects/demo", arguments: args } },
});

await test("Scheduler requests match Rust conformance", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("../fixtures/scheduler-editor-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as Array<{ name: string; request: unknown; accepted: boolean }>;
  for (const entry of cases)
    assert.equal(
      hostRequestSchema.safeParse({ type: "scheduler", request: entry.request })
        .success,
      entry.accepted,
      entry.name,
    );
});

await test("carries the complete client Scheduler options through the host protocol", () => {
  const args = [
    "create",
    ...schedulerValueFlags.flatMap((flag) => [flag, "value"]),
  ];
  assert.equal(
    hostRequestSchema.safeParse({
      type: "scheduler",
      request: invocation(args),
    }).success,
    true,
  );
});

await test("rejects unknown actions, options, missing values, NUL and oversized requests", () => {
  for (const args of [
    ["service-all"],
    ["create", "--unknown", "value"],
    ["create", "--prompt"],
    ["create", "--prompt", "bad\0value"],
    ["create", "--prompt", "x".repeat(1_800_001)],
  ])
    assert.equal(schedulerArgumentsSchema.safeParse(args).success, false);
});

await test("allows RALPH discovery exclusively for the scheduled flow picker", () => {
  const request = { ...invocation([]), command: "run_ralph_command" };
  for (const args of [
    ["list", "--scope", "workspace"],
    ["list", "--scope", "user"],
  ])
    assert.equal(
      schedulerRequestSchema.safeParse({
        ...request,
        args: { request: { workspaceRoot: "/projects/demo", arguments: args } },
      }).success,
      true,
    );
  assert.equal(
    schedulerRequestSchema.safeParse({
      ...request,
      args: {
        request: {
          workspaceRoot: "/projects/demo",
          arguments: ["run", "flow"],
        },
      },
    }).success,
    false,
  );
});
