import { parentPort, workerData } from "node:worker_threads";
import { planSchedule, type SchedulePlanInput } from "./schedule-plan";
import {
  previewRecurrence,
  parseRecurrenceInstant,
  RecurrenceError,
  type RecurrenceInput,
} from "@machdoch/recurrence";

const input = workerData as {
  recurrence: RecurrenceInput;
  after: number | string;
  count: number;
  fromActivation?: boolean;
  plan?: SchedulePlanInput;
};
try {
  const result = input.plan
    ? planSchedule(input.plan)
    : previewRecurrence(
        input.recurrence,
        typeof input.after === "string"
          ? parseRecurrenceInstant(input.after)
          : input.after,
        input.count,
        input.fromActivation,
      );
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    code: error instanceof RecurrenceError ? error.code : "invalid_recurrence",
    message:
      error instanceof RecurrenceError
        ? error.message.slice(0, 500)
        : "The recurrence could not be evaluated. Review its dates and rules.",
  });
}
