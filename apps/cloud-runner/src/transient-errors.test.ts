import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientRunnerError,
  RunnerRequestError,
} from "@machdoch/cloud-client";

await test("retries throttled, timed-out and server failures but not rejected requests", () => {
  const transient = (status: number) =>
    isTransientRunnerError(new RunnerRequestError(status, "code", "message"));
  assert.deepEqual([408, 429, 500, 503].map(transient), [true, true, true, true]);
  assert.deepEqual(
    [400, 401, 403, 404, 409].map(transient),
    [false, false, false, false, false],
  );
});
