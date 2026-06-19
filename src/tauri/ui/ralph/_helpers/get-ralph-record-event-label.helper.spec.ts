import type { RalphInputRequest, RalphRunEvent } from "../../../../core/ralph.js";
import { getRalphRecordEventLabel } from "./get-ralph-record-event-label.helper";

const inputRequest = {
  id: "request-1",
  runId: "run-1",
  blockId: "input-1",
  blockType: "INPUT",
  title: "Need approval",
  fields: [],
  createdAt: "2026-06-19T10:00:00.000Z",
} satisfies RalphInputRequest;

describe("Ralph record event label helper", () => {
  it.each([
    [{ type: "block-start", blockId: "prompt-1", attempt: 1 }, "Started prompt-1"],
    [
      {
        type: "block-output",
        blockId: "prompt-1",
        output: "SUCCESS",
        summary: "Done",
      },
      "prompt-1 returned SUCCESS",
    ],
    [
      { type: "edge-route", from: "prompt-1", output: "SUCCESS", to: "end-1" },
      "prompt-1.SUCCESS routed to end-1",
    ],
    [
      { type: "retry", blockId: "validator-1", attempt: 2, reason: "Try again" },
      "Retry validator-1: Try again",
    ],
    [
      { type: "input-required", blockId: "input-1", request: inputRequest },
      "input-1 waiting for input",
    ],
    [
      { type: "input-submitted", blockId: "input-1", requestId: "request-1" },
      "input-1 input submitted",
    ],
    [
      { type: "input-cancelled", blockId: "input-1", requestId: "request-1" },
      "input-1 input cancelled",
    ],
    [
      { type: "crash", blockId: "prompt-1", output: "ERROR", reason: "Boom" },
      "Crash at prompt-1: Boom",
    ],
    [
      {
        type: "end",
        blockId: "end-1",
        status: "completed",
        summary: "Finished",
      },
      "completed: Finished",
    ],
  ] satisfies Array<[RalphRunEvent, string]>)(
    "formats %s",
    (event, expected) => {
      expect(getRalphRecordEventLabel(event)).toBe(expected);
    },
  );
});
